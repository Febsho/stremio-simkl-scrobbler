import { Manifest } from 'stremio-addon-sdk';

const manifest: Manifest = {
    id: 'com.example.simkl-scrobbler',
    version: '1.2.0',
    name: 'Simkl Scrobbler',
    description: 'Scrobble to Simkl + view your Watching & Plan to Watch lists',

    resources: ['subtitles', 'catalog'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu:'], // IMDb and Kitsu IDs

    catalogs: [
        // Movies
        { type: 'movie', id: 'simkl-watching-movies', name: 'Simkl: Watching (Movies)' },
        { type: 'movie', id: 'simkl-plantowatch-movies', name: 'Simkl: Plan to Watch (Movies)' },
        // Shows
        { type: 'series', id: 'simkl-watching-shows', name: 'Simkl: Watching (Shows)' },
        { type: 'series', id: 'simkl-plantowatch-shows', name: 'Simkl: Plan to Watch (Shows)' },
        // Anime (Simkl)
        { type: 'series', id: 'simkl-watching-anime', name: 'Simkl: Watching (Anime)' },
        { type: 'series', id: 'simkl-plantowatch-anime', name: 'Simkl: Plan to Watch (Anime)' },
        // Anime (AniList)
        { type: 'anime', id: 'anilist-watching-anime', name: 'AniList: Watching' },
        { type: 'anime', id: 'anilist-plan-anime', name: 'AniList: Plan to Watch' },
    ],

    behaviorHints: {
        configurable: true,
        configurationRequired: true,
    },

    config: [
        {
            key: 'token',
            type: 'text',
            title: 'Simkl Access Token (auto-filled after OAuth)',
        },
        {
            key: 'threshold',
            type: 'text',
            title: 'Scrobble Threshold (0.1-1.0, default: 0.8)',
            default: '0.8',
        },
    ],
};

export default manifest;
