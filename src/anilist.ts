import fetch from 'node-fetch';

const ANILIST_API_URL = 'https://graphql.anilist.co';
const ANILIST_AUTH_URL = 'https://anilist.co/api/v2/oauth/authorize';

const ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';

/**
 * Build AniList OAuth authorization URL.
 * Uses Authorization Code Grant (response_type=code).
 */
export function getAniListAuthUrl(redirectUri: string): string {
    const clientId = process.env.ANILIST_CLIENT_ID;
    return `${ANILIST_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
}

/**
 * Exchange authorization code for access token.
 */
export async function exchangeAniListCodeForToken(code: string, redirectUri: string): Promise<string> {
    const clientId = process.env.ANILIST_CLIENT_ID;
    const clientSecret = process.env.ANILIST_CLIENT_SECRET;

    const response = await fetch(ANILIST_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`AniList token exchange failed: ${response.status} ${error}`);
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
}

/**
 * Execute a GraphQL query/mutation against AniList API.
 */
async function graphqlRequest(
    query: string,
    variables: Record<string, any>,
    accessToken?: string
): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(ANILIST_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`AniList API error: ${response.status} ${error}`);
    }

    const data = await response.json() as { data?: any; errors?: any[] };

    if (data.errors && data.errors.length > 0) {
        throw new Error(`AniList GraphQL error: ${data.errors[0].message}`);
    }

    return data.data;
}

/**
 * Search for anime on AniList by Kitsu ID.
 * Returns AniList media ID if found, null otherwise.
 */
export async function searchAnimeByKitsu(
    kitsuId: string,
    accessToken: string
): Promise<{ anilistId: number; title: string } | null> {
    // AniList doesn't support direct Kitsu ID lookup, so we need to search by ID format
    // First try to get the anime info from Kitsu to get the title, then search AniList

    // For now, we'll use the idMal mapping if available through Simkl
    // This is a simplified approach - in production you'd want a proper ID mapping service

    const query = `
        query ($search: String) {
            Media(search: $search, type: ANIME) {
                id
                title {
                    romaji
                    english
                }
            }
        }
    `;

    try {
        const data = await graphqlRequest(query, { search: kitsuId }, accessToken);
        if (data?.Media) {
            return {
                anilistId: data.Media.id,
                title: data.Media.title.english || data.Media.title.romaji,
            };
        }
    } catch (error) {
        console.error('AniList search failed:', error);
    }

    return null;
}

/**
 * Search for anime on AniList by MAL ID.
 */
export async function searchAnimeByMalId(
    malId: number,
    accessToken: string
): Promise<{ anilistId: number; title: string } | null> {
    const query = `
        query ($malId: Int) {
            Media(idMal: $malId, type: ANIME) {
                id
                title {
                    romaji
                    english
                }
            }
        }
    `;

    try {
        const data = await graphqlRequest(query, { malId }, accessToken);
        if (data?.Media) {
            return {
                anilistId: data.Media.id,
                title: data.Media.title.english || data.Media.title.romaji,
            };
        }
    } catch (error) {
        console.error('AniList MAL search failed:', error);
    }

    return null;
}

/**
 * Update anime progress on AniList (mark episodes as watched).
 * Uses SaveMediaListEntry mutation.
 */
export async function updateAnimeProgress(
    anilistId: number,
    episode: number,
    accessToken: string
): Promise<boolean> {
    const mutation = `
        mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
            SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
                id
                progress
                status
            }
        }
    `;

    try {
        const data = await graphqlRequest(
            mutation,
            {
                mediaId: anilistId,
                progress: episode,
                status: 'CURRENT', // Set to "Watching" status
            },
            accessToken
        );

        if (data?.SaveMediaListEntry) {
            console.log(`AniList: Updated progress to episode ${episode} for media ${anilistId}`);
            return true;
        }
    } catch (error) {
        console.error('AniList progress update failed:', error);
    }

    return false;
}

/**
 * Get current user info from AniList (to verify token is valid).
 */
export async function getAniListUser(accessToken: string): Promise<{ id: number; name: string } | null> {
    const query = `
        query {
            Viewer {
                id
                name
            }
        }
    `;

    try {
        const data = await graphqlRequest(query, {}, accessToken);
        if (data?.Viewer) {
            return {
                id: data.Viewer.id,
                name: data.Viewer.name,
            };
        }
    } catch (error) {
        console.error('Failed to get AniList user:', error);
    }

    return null;
}
/**
 * Get user's anime list from AniList by status.
 * Status: "CURRENT" (Watching) or "PLANNING" (Plan to Watch).
 */
export async function getAniListUserList(
    status: 'CURRENT' | 'PLANNING',
    accessToken: string
): Promise<any[]> {
    const user = await getAniListUser(accessToken);
    if (!user) return [];

    const query = `
        query ($userId: Int, $status: MediaListStatus) {
            MediaListCollection(userId: $userId, type: ANIME, status: $status) {
                lists {
                    entries {
                        media {
                            id
                            idMal
                            title {
                                english
                                romaji
                            }
                            coverImage {
                                large
                            }
                            format
                            episodes
                            averageScore
                            description
                            genres
                            seasonYear
                        }
                    }
                }
            }
        }
    `;

    try {
        const data = await graphqlRequest(
            query,
            { userId: user.id, status },
            accessToken
        );

        // Flatten the lists
        const entries = data?.MediaListCollection?.lists?.flatMap((l: any) => l.entries) || [];

        // Convert to Stremio MetaPreview format
        return entries.map((entry: any) => {
            const media = entry.media;
            const title = media.title.english || media.title.romaji;

            return {
                // We use idMal as a fallback to try and get a Kitsu-compatible ID if possible, 
                // but strictly speaking we don't have a reliable mapping here without an external service.
                // We'll use the Kitsu prefix with the AniList ID as a best-effort placeholder.
                id: `kitsu:${media.id}`,
                type: 'anime',
                name: title,
                poster: media.coverImage?.large,
                description: media.description,
                releaseInfo: media.seasonYear ? String(media.seasonYear) : undefined,
            };
        });

    } catch (error) {
        console.error(`Failed to fetch AniList ${status} list:`, error);
        return [];
    }
}
