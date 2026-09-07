import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { assertConfig, config } from './config.js';
import { extractContracts } from './contracts.js';
import { fetchPage } from './fetch-page.js';
import { contractEmbed } from './alert.js';
import { startMonitor, watch } from './monitor.js';
import { loadStore, removeWatcher, saveStore, watchers } from './store.js';

assertConfig();
await loadStore();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, ready => {
  console.log(`Logged in as ${ready.user.tag}; checking ${watchers().length} watcher(s) every ${config.pollIntervalMs}ms.`);
  startMonitor(client, config.pollIntervalMs);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  try {
    // Discord expires an interaction after roughly three seconds. Acknowledge
    // before doing any watcher/store work so rapid browser samples cannot make
    // normal management commands appear to hang.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'help') {
      await interaction.editReply({
        content: [
          '**Website Contract Watcher — command guide**',
          '`/watch url [channel] [role]` — start or update a rendered-frontend watch. It alerts only when a newly visible, full contract address appears.',
          '`/unwatch id` — stop one site watcher.',
          '`/list` — show watched sites and their IDs.',
          '',
          '**Use just this:** `/watch` once. Pick an alerts channel and optional role. The first scan is a baseline; later new visible contracts ping the role.'
        ].join('\n')
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply('You need **Manage Server** to manage website watchers.'); return;
    }
    if (interaction.commandName === 'watch') {
      const url = interaction.options.getString('url', true);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const role = interaction.options.getRole('role');
      if (!channel?.isTextBased()) throw new Error('Choose a text channel for alerts.');
      const normalized = new URL(url).toString();
      const existing = watchers().find(w => w.guildId === interaction.guildId && w.url === normalized);
      if (existing) {
        existing.channelId = channel.id;
        existing.alertRoleId = role?.id;
        existing.rendered = true;
        existing.initialized = false;
        existing.baselineUntil = Date.now() + 30_000;
        existing.pages = [existing.url];
        existing.crawlerVersion = 15;
        existing.preferNewest = true;
        await saveStore();
        await interaction.editReply(`Updated <${existing.url}>. It will scan the rendered frontend and use <#${channel.id}>${role ? `, pinging <@&${role.id}> for new contracts` : ''}. The next scan is a fresh baseline.`);
        return;
      }
      const watcher = await watch({ guildId: interaction.guildId, channelId: channel.id, url, rendered: true });
      watcher.alertRoleId = role?.id;
      await saveStore();
        await interaction.editReply(`Watching <${watcher.url}> in <#${watcher.channelId}>. ID: \`${watcher.id}\`. The current frontend is the baseline; newly visible full contracts${role ? ` ping <@&${role.id}>` : ' alert without a role ping'}.`);
    } else if (interaction.commandName === 'unwatch') {
      const id = interaction.options.getString('id', true);
      const removed = await removeWatcher(id, interaction.guildId);
      await interaction.editReply(removed ? `Stopped watcher \`${id}\`.` : `No watcher \`${id}\` exists in this server.`);
    } else if (interaction.commandName === 'list') {
      const mine = watchers().filter(w => w.guildId === interaction.guildId);
      const rows = mine.map(w => {
        const hosts = [...new Set((w.pages ?? [w.url]).map(page => new URL(page).hostname))];
        const shown = hosts.slice(0, 4).join(', ');
        return `• \`${w.id}\` → <${w.url}> → <#${w.channelId}> — ${w.pages?.length ?? 1} page(s); hosts: ${shown}${hosts.length > 4 ? ` +${hosts.length - 4} more` : ''} (${w.rendered ? 'rendered' : 'HTTP'})`;
      });
      await interaction.editReply(rows.length ? rows.join('\n') : 'No active watchers in this server.');
    } else if (interaction.commandName === 'pages') {
      const id = interaction.options.getString('id', true);
      const watcher = watchers().find(w => w.id === id && w.guildId === interaction.guildId);
      if (!watcher) throw new Error(`No watcher \`${id}\` exists in this server.`);
      const pages = watcher.pages ?? [watcher.url];
      const output = pages.slice(0, 25).map(page => `• <${page}>`).join('\n');
      await interaction.reply({ content: `**${pages.length} discovered page(s)** for \`${id}\`:\n${output}${pages.length > 25 ? `\n… and ${pages.length - 25} more.` : ''}`, flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === 'paths' || interaction.commandName === 'subdomains') {
      const id = interaction.options.getString('id', true);
      const watcher = watchers().find(w => w.id === id && w.guildId === interaction.guildId);
      if (!watcher) throw new Error(`No watcher \`${id}\` exists in this server.`);
      const pages = watcher.pages ?? [watcher.url];
      const isHosts = interaction.commandName === 'subdomains';
      const items = isHosts ? [...new Set(pages.map(page => new URL(page).hostname))].sort() : [...new Set(pages)].sort();
      const filename = `${isHosts ? 'subdomains' : 'paths'}-${id}.txt`;
      await interaction.reply({
        content: `${items.length} ${isHosts ? 'discovered host(s)' : 'discovered URL path(s)'} for \`${id}\`.`,
        files: [{ attachment: Buffer.from(`${items.join('\n')}\n`), name: filename }],
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.commandName === 'launchpad') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const id = interaction.options.getString('id', true);
      const watcher = watchers().find(w => w.id === id && w.guildId === interaction.guildId);
      if (!watcher) throw new Error(`No watcher \`${id}\` exists in this server.`);
      const status = watcher.launchpad ?? { isLaunchpad: false, evidence: 'the first site scan has not completed yet', observedMints: [] };
      await interaction.editReply(status.isLaunchpad
        ? `**${status.name} appears to be a launchpad.** The frontend has exposed **${(status.observedMints?.length ?? 0).toLocaleString()}** unique token path(s) to this watcher. Evidence: ${status.evidence}.`
        : `**This site does not currently appear to be a launchpad.** ${status.evidence}.`);
    } else if (interaction.commandName === 'render') {
      const id = interaction.options.getString('id', true);
      const watcher = watchers().find(w => w.id === id && w.guildId === interaction.guildId);
      if (!watcher) throw new Error(`No watcher \`${id}\` exists in this server.`);
      watcher.rendered = interaction.options.getBoolean('enabled', true);
      // A changed rendering mode needs a fresh baseline so old/static and new/frontend content do not cross-alert.
      watcher.initialized = false;
      await saveStore();
      await interaction.reply({ content: `Watcher \`${id}\` is now using **${watcher.rendered ? 'rendered frontend' : 'HTTP'}** mode. Its next scan establishes a fresh baseline.`, flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === 'alerts') {
      const id = interaction.options.getString('id', true);
      const watcher = watchers().find(w => w.id === id && w.guildId === interaction.guildId);
      if (!watcher) throw new Error(`No watcher \`${id}\` exists in this server.`);
      const channel = interaction.options.getChannel('channel', true);
      const role = interaction.options.getRole('role', true);
      if (!channel.isTextBased()) throw new Error('Choose a text channel for alerts.');
      watcher.channelId = channel.id;
      watcher.alertRoleId = role.id;
      await saveStore();
      await interaction.reply({ content: `Watcher \`${id}\` will post contract alerts in <#${channel.id}> and ping <@&${role.id}>.`, allowedMentions: { roles: [role.id] }, flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === 'scan') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const url = interaction.options.getString('url', true);
      const contracts = extractContracts(await fetchPage(url, interaction.options.getBoolean('rendered') ?? config.usePlaywright));
      await interaction.editReply(contracts.length ? `Found ${contracts.length} possible contract(s); posting results here.` : 'No EVM or Solana contract addresses found.');
      for (const contract of contracts.slice(0, 10)) await interaction.channel.send({ embeds: [await contractEmbed(contract, url)] });
    }
  } catch (error) {
    // The interaction may already have expired before it reached this process.
    // There is no valid callback left in that case; logging is enough.
    if (error.code === 10062) {
      console.warn(`Interaction expired before acknowledgement (${interaction.commandName}).`);
      return;
    }
    const message = `Could not complete that request: ${error.message}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(message); else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
});

client.login(config.token);
