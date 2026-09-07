import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.js';

if (!config.token || !config.clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show the website watcher command guide'),
  new SlashCommandBuilder().setName('watch').setDescription('Watch a public site for changes and new contracts')
    .addStringOption(o => o.setName('url').setDescription('Public http(s) page URL').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Where alerts should go').setRequired(false))
    .addRoleOption(o => o.setName('role').setDescription('Role to ping for new contracts').setRequired(false)),
  new SlashCommandBuilder().setName('unwatch').setDescription('Stop a watcher').addStringOption(o => o.setName('id').setDescription('Watcher ID from /watches').setRequired(true)),
  new SlashCommandBuilder().setName('list').setDescription('List your watched sites and their IDs')
].map(command => command.toJSON());
const rest = new REST({ version: '10' }).setToken(config.token);
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
await rest.put(route, { body: commands });
console.log(config.guildId
  ? `Registered ${commands.length} commands to Discord server ID ${config.guildId}.`
  : `Registered ${commands.length} global commands. Global command updates can take up to an hour.`);
