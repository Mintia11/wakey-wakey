import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

type ChatId = string | number;

type RouteLocation = {
    latLng: { latitude: number; longitude: number };
};

type Route = {
    duration: string;
    staticDuration: string;
    distanceMeters: number;
    polyline: { encodedPolyline: string };
    legs: [{ startLocation: RouteLocation; endLocation: RouteLocation }, ...Array<{ startLocation: RouteLocation; endLocation: RouteLocation }>];
};

function requiredEnv(name: keyof NodeJS.ProcessEnv) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

const BOT_TOKEN = requiredEnv('BOT_TOKEN');
const OWNER_ID = requiredEnv('OWNER_ID');
const GOOGLE_MAPS_KEY = requiredEnv('GOOGLE_MAPS_KEY');
const HOME = requiredEnv('HOME');
const DESTINATION = requiredEnv('DESTINATION');
const IMAGE_BASE_URL = requiredEnv('IMAGE_BASE_URL').replace(/\/+$/, '');
const IMAGE_PORT = Number(process.env.IMAGE_PORT ?? '3000') || 3000;
const IMAGE_TTL_SECONDS = Math.max(60, Number(process.env.IMAGE_TTL_SECONDS ?? '900') || 900);
const SEND_AT = process.env.SEND_AT ?? '30 7 * * *';
const TZ = process.env.TZ;

const bot = new Telegraf(BOT_TOKEN);
const imageTtlMs = IMAGE_TTL_SECONDS * 1000;
const imageStore = new Map<string, { buffer: Buffer; expiresAt: number }>();
const triggerCommands = ['eta', 'wenclair', 'wens', 'enid'] as const;

function cacheImage(buffer: Buffer) {
    const id = randomUUID();
    imageStore.set(id, { buffer, expiresAt: Date.now() + imageTtlMs });
    return `${IMAGE_BASE_URL}/maps/${id}.png`;
}

function startImageServer() {
    const server = createServer((req, res) => {
        if (!req.url) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad request');
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${IMAGE_PORT}`}`);
        if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }

        const match = /^\/maps\/([0-9a-f-]+)\.png$/i.exec(url.pathname);
        const imageId = match?.[1];
        if (!imageId) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }

        const image = imageStore.get(imageId);
        if (!image || image.expiresAt < Date.now()) {
            imageStore.delete(imageId);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Expired or missing image');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=300',
        });
        res.end(image.buffer);
    });

    server.listen(IMAGE_PORT, () => {
        console.log(`Image server listening on :${IMAGE_PORT}`);
    });

    return server;
}

function parseDurationSeconds(duration: string) {
    const seconds = Number.parseInt(duration, 10);
    if (Number.isNaN(seconds)) throw new Error(`Invalid duration from Routes API: ${duration}`);
    return seconds;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, image] of imageStore.entries()) {
        if (image.expiresAt < now) imageStore.delete(id);
    }
}, 60_000).unref();

const imageServer = startImageServer();

async function getRoute(): Promise<Route> {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
            'X-Goog-FieldMask': [
                'routes.duration',
                'routes.staticDuration',
                'routes.distanceMeters',
                'routes.polyline.encodedPolyline',
                'routes.legs.startLocation',
                'routes.legs.endLocation',
            ].join(','),
        },
        body: JSON.stringify({
            origin: { address: HOME },
            destination: { address: DESTINATION },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
            polylineQuality: 'OVERVIEW', // shorter line, keeps the map URL small
        }),
    });

    if (!res.ok) throw new Error(`Routes API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { routes?: Route[] };
    if (!data.routes?.[0]) throw new Error('No route found');
    return data.routes[0];
}

async function getMapImage(route: Route) {
    const { startLocation, endLocation } = route.legs[0];
    const fmt = (location: RouteLocation) => `${location.latLng.latitude},${location.latLng.longitude}`;

    const params = new URLSearchParams({
        size: '640x480',
        scale: '2',
        maptype: 'roadmap',
        key: GOOGLE_MAPS_KEY,
    });
    params.append('markers', `color:red|label:A|${fmt(startLocation)}`);
    params.append('markers', `color:red|label:B|${fmt(endLocation)}`);
    params.append('path', `color:0x4285F4ff|weight:5|enc:${route.polyline.encodedPolyline}`);

    const res = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${params}`);
    if (!res.ok) throw new Error(`Static Maps ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
}

async function buildTravelSnapshot() {
    const route = await getRoute();
    const withTraffic = Math.round(parseDurationSeconds(route.duration) / 60);
    const noTraffic = Math.round(parseDurationSeconds(route.staticDuration) / 60);
    const km = (route.distanceMeters / 1000).toFixed(1);
    const caption = `🚗 About ${withTraffic} min (${noTraffic} min without traffic), ${km} km.`;
    const mapsUrl =
        'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
        `&origin=${encodeURIComponent(HOME)}` +
        `&destination=${encodeURIComponent(DESTINATION)}`;
    const imageUrl = cacheImage(await getMapImage(route));
    return { caption, mapsUrl, imageUrl };
}

async function sendTravelTime(chatId: ChatId) {
    try {
        const snapshot = await buildTravelSnapshot();
        await bot.telegram.sendPhoto(chatId, snapshot.imageUrl, {
            caption: snapshot.caption,
            reply_markup: {
                inline_keyboard: [[{ text: '🗺️ Open in Google Maps', url: snapshot.mapsUrl }]],
            },
        });
    } catch (err) {
        console.error(err);
        await bot.telegram.sendMessage(chatId, '⚠️ Could not compute the travel time.');
    }
}

cron.schedule(SEND_AT, () => sendTravelTime(OWNER_ID), TZ ? { timezone: TZ } : undefined);

bot.start((ctx) => ctx.reply(`Your chat ID is ${ctx.chat.id}, person id is ${ctx.from.id}`));

for (const command of triggerCommands) {
    bot.command(command, (ctx) => {
        return sendTravelTime(ctx.chat.id);
    });
}

bot.inlineQuery(/.*/, async (ctx) => {
    const q = ctx.inlineQuery.query.trim().toLowerCase();
    if (!triggerCommands.includes(q as (typeof triggerCommands)[number]) && q !== '') {
        await ctx.answerInlineQuery(
            [
                {
                    type: 'article',
                    id: 'eta-usage',
                    title: 'Use eta / wenclair / wens / enid',
                    input_message_content: {
                        message_text: 'Type eta, wenclair, wens, or enid after @your_bot_username.',
                    },
                },
            ],
            { is_personal: true, cache_time: 1 }
        );
        return;
    }

    try {
        const snapshot = await buildTravelSnapshot();
        await ctx.answerInlineQuery(
            [
                {
                    type: 'photo',
                    id: `eta-${Date.now()}`,
                    photo_url: snapshot.imageUrl,
                    thumbnail_url: snapshot.imageUrl,
                    caption: snapshot.caption,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🗺️ Open in Google Maps', url: snapshot.mapsUrl }]],
                    },
                },
            ],
            { is_personal: true, cache_time: 5 }
        );
    } catch (err) {
        console.error(err);
        await ctx.answerInlineQuery(
            [
                {
                    type: 'article',
                    id: 'eta-error',
                    title: 'Could not compute travel time',
                    input_message_content: {
                        message_text: '⚠️ Could not compute the travel time.',
                    },
                },
            ],
            { is_personal: true, cache_time: 1 }
        );
    }
});

void bot.telegram.setMyCommands(
    triggerCommands.map((command) => ({
        command,
        description: 'Current ETA with map',
    }))
);

bot.launch();

function shutdown(signal: 'SIGINT' | 'SIGTERM', server: Server) {
    bot.stop(signal);
    server.close();
}

process.once('SIGINT', () => shutdown('SIGINT', imageServer));
process.once('SIGTERM', () => shutdown('SIGTERM', imageServer));