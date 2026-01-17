// Allow any usage of the stremio-addon-sdk module without type errors
declare module 'stremio-addon-sdk' {
    export const addonBuilder: any;
    export const serveHTTP: any;
    export const getRouter: any;
    export type Args = any;
    export type Manifest = any;
    export type Stream = any;
    export type Meta = any;
    export type AddonInterface = any;
}
