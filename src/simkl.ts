import fetch from 'node-fetch';

const SIMKL_API_BASE = 'https://api.simkl.com';

interface SimklTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

interface SimklIdLookupResult {
    type: 'movie' | 'show' | 'anime';
    ids: {
        simkl: number;
        imdb?: string;
        tmdb?: string;
        mal?: number; // Added MAL ID
        slug?: string;
    };
    title?: string;
    year?: number;
    runtime?: number; // in minutes
}

interface SimklMovieInfo {
    ids: { simkl: number };
    title: string;
    runtime: number; // in minutes
}

interface SimklShowInfo {
    ids: { simkl: number };
    title: string;
    runtime: number; // episode runtime in minutes
}

/**
 * Get headers required for Simkl API requests.
 */
function getHeaders(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'simkl-api-key': process.env.SIMKL_CLIENT_ID || '',
    };

    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    return headers;
}

/**
 * Exchange OAuth2 authorization code for access token.
 */
export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
    const response = await fetch(`${SIMKL_API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            client_id: process.env.SIMKL_CLIENT_ID,
            client_secret: process.env.SIMKL_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to exchange code for token: ${response.status} ${error}`);
    }

    const data = (await response.json()) as SimklTokenResponse;
    return data.access_token;
}

/**
 * Build OAuth2 authorization URL for Simkl.
 */
export function getAuthUrl(redirectUri: string): string {
    const clientId = process.env.SIMKL_CLIENT_ID;
    return `https://simkl.com/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * Look up a media item by IMDb ID and get its Simkl ID + runtime.
 * Returns null if not found.
 */
export async function lookupByImdb(
    imdbId: string,
    accessToken: string
): Promise<{ simklId: number; runtime: number; type: 'movie' | 'show' | 'anime' } | null> {
    const response = await fetch(
        `${SIMKL_API_BASE}/search/id?imdb=${imdbId}`,
        { headers: getHeaders(accessToken) }
    );

    if (!response.ok) {
        console.error(`Simkl lookup failed for ${imdbId}: ${response.status}`);
        return null;
    }

    const results = (await response.json()) as SimklIdLookupResult[];

    if (!results || results.length === 0) {
        console.warn(`No Simkl results found for IMDb ID: ${imdbId}`);
        return null;
    }

    const item = results[0];

    // Default runtimes if not available
    const defaultRuntimes: Record<string, number> = {
        movie: 90,
        show: 45,
        anime: 25,
    };

    return {
        simklId: item.ids.simkl,
        runtime: item.runtime || defaultRuntimes[item.type] || 45,
        type: item.type,
    };
}

/**
 * Get detailed movie info including runtime.
 */
export async function getMovieInfo(simklId: number, accessToken: string): Promise<SimklMovieInfo | null> {
    const response = await fetch(
        `${SIMKL_API_BASE}/movies/${simklId}`,
        { headers: getHeaders(accessToken) }
    );

    if (!response.ok) {
        console.error(`Failed to get movie info for ${simklId}: ${response.status}`);
        return null;
    }

    return (await response.json()) as SimklMovieInfo;
}

/**
 * Get detailed show info including episode runtime.
 */
export async function getShowInfo(simklId: number, accessToken: string): Promise<SimklShowInfo | null> {
    const response = await fetch(
        `${SIMKL_API_BASE}/tv/${simklId}`,
        { headers: getHeaders(accessToken) }
    );

    if (!response.ok) {
        console.error(`Failed to get show info for ${simklId}: ${response.status}`);
        return null;
    }

    return (await response.json()) as SimklShowInfo;
}

/**
 * Scrobble a movie to Simkl watched history.
 */
export async function scrobbleMovie(simklId: number, accessToken: string): Promise<boolean> {
    const watchedAt = new Date().toISOString();

    const response = await fetch(`${SIMKL_API_BASE}/sync/history`, {
        method: 'POST',
        headers: getHeaders(accessToken),
        body: JSON.stringify({
            movies: [
                {
                    ids: { simkl: simklId },
                    watched_at: watchedAt,
                },
            ],
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to scrobble movie ${simklId}: ${response.status} ${error}`);
        return false;
    }

    console.log(`Successfully scrobbled movie ${simklId} to Simkl`);
    return true;
}

/**
 * Scrobble a TV episode to Simkl watched history.
 */
export async function scrobbleEpisode(
    simklId: number,
    season: number,
    episode: number,
    accessToken: string
): Promise<boolean> {
    const watchedAt = new Date().toISOString();

    const response = await fetch(`${SIMKL_API_BASE}/sync/history`, {
        method: 'POST',
        headers: getHeaders(accessToken),
        body: JSON.stringify({
            shows: [
                {
                    ids: { simkl: simklId },
                    seasons: [
                        {
                            number: season,
                            episodes: [
                                {
                                    number: episode,
                                    watched_at: watchedAt,
                                },
                            ],
                        },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to scrobble episode S${season}E${episode} of ${simklId}: ${response.status} ${error}`);
        return false;
    }

    console.log(`Successfully scrobbled S${season}E${episode} of show ${simklId} to Simkl`);
    return true;
}

/**
 * Look up an anime by Kitsu ID and get its Simkl ID + runtime.
 * Returns null if not found.
 */
export async function lookupByKitsu(
    kitsuId: string,
    accessToken: string
): Promise<{ simklId: number; runtime: number; type: 'anime'; ids?: { mal?: number } } | null> {
    const response = await fetch(
        `${SIMKL_API_BASE}/search/id?kitsu=${kitsuId}`,
        { headers: getHeaders(accessToken) }
    );

    if (!response.ok) {
        console.error(`Simkl lookup failed for Kitsu ${kitsuId}: ${response.status}`);
        return null;
    }

    const results = (await response.json()) as SimklIdLookupResult[];

    if (!results || results.length === 0) {
        console.warn(`No Simkl results found for Kitsu ID: ${kitsuId}`);
        return null;
    }

    const item = results[0];

    return {
        simklId: item.ids.simkl,
        runtime: item.runtime || 24, // Default anime episode runtime
        type: 'anime',
        ids: {
            mal: item.ids.mal,
        },
    };
}

interface SimklAnimeInfo {
    ids: { simkl: number };
    title: string;
    runtime: number;
}

/**
 * Get detailed anime info including episode runtime.
 */
export async function getAnimeInfo(simklId: number, accessToken: string): Promise<SimklAnimeInfo | null> {
    const response = await fetch(
        `${SIMKL_API_BASE}/anime/${simklId}`,
        { headers: getHeaders(accessToken) }
    );

    if (!response.ok) {
        console.error(`Failed to get anime info for ${simklId}: ${response.status}`);
        return null;
    }

    return (await response.json()) as SimklAnimeInfo;
}

/**
 * Scrobble an anime episode to Simkl watched history.
 */
export async function scrobbleAnime(
    simklId: number,
    episodeNumber: number,
    accessToken: string
): Promise<boolean> {
    const watchedAt = new Date().toISOString();

    const response = await fetch(`${SIMKL_API_BASE}/sync/history`, {
        method: 'POST',
        headers: getHeaders(accessToken),
        body: JSON.stringify({
            shows: [
                {
                    ids: { simkl: simklId },
                    seasons: [
                        {
                            number: 1, // Anime typically uses season 1 with absolute episode numbers
                            episodes: [
                                {
                                    number: episodeNumber,
                                    watched_at: watchedAt,
                                },
                            ],
                        },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to scrobble anime episode ${episodeNumber} of ${simklId}: ${response.status} ${error}`);
        return false;
    }

    console.log(`Successfully scrobbled anime episode ${episodeNumber} of ${simklId} to Simkl`);
    return true;
}

// ============================================
// Watchlist / Catalog functions
// ============================================

export interface SimklListItem {
    show?: {
        ids: { simkl: number; imdb?: string; slug?: string };
        title: string;
        poster?: string;
        year?: number;
    };
    movie?: {
        ids: { simkl: number; imdb?: string; slug?: string };
        title: string;
        poster?: string;
        year?: number;
    };
    anime?: {
        ids: { simkl: number; imdb?: string; mal?: string; slug?: string };
        title: string;
        poster?: string;
        year?: number;
    };
    status: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped';
}

type ListType = 'movies' | 'shows' | 'anime';
type ListStatus = 'watching' | 'plantowatch';

/**
 * Fetch user's list (watching, plantowatch, etc.) for a specific media type.
 */
export async function getUserList(
    listType: ListType,
    status: ListStatus,
    accessToken: string
): Promise<SimklListItem[]> {
    const endpoint = `${SIMKL_API_BASE}/sync/all-items/${listType}/${status}`;

    const response = await fetch(endpoint, {
        headers: getHeaders(accessToken),
    });

    if (!response.ok) {
        console.error(`Failed to fetch ${listType} ${status} list: ${response.status}`);
        return [];
    }

    const data = await response.json();
    return (data as { [key: string]: SimklListItem[] })[listType] || [];
}

/**
 * Convert Simkl list item to Stremio meta object.
 */
export function simklItemToStremiometa(item: SimklListItem, type: 'movie' | 'series'): {
    id: string;
    type: string;
    name: string;
    poster?: string;
    year?: number;
} | null {
    const media = item.movie || item.show || item.anime;
    if (!media) return null;

    // Prefer IMDb ID for movies/shows, fallback to simkl ID
    let id: string;
    if (item.movie && media.ids.imdb) {
        id = media.ids.imdb;
    } else if (item.show && media.ids.imdb) {
        id = media.ids.imdb;
    } else if (item.anime) {
        // For anime, use kitsu format if available, otherwise simkl
        id = `kitsu:${media.ids.simkl}`;
    } else {
        id = `simkl:${media.ids.simkl}`;
    }

    return {
        id,
        type,
        name: media.title,
        poster: media.poster ? `https://simkl.in/posters/${media.poster}_m.webp` : undefined,
        year: media.year,
    };
}

