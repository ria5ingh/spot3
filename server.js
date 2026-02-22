//encrpyt api keys
import "dotenv/config";
//webserver framework for Node JS
import express from "express";
//Node JS module so u don't have to worry format of file paths
import path from "path";
//lets you make file a url so you can open on browser to test
import { fileURLToPath } from "url";
//importing gemini
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LASTFM_API_KEY = process.env.LASTFM_API_KEY || "";
const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Build user message text (builds a list that can be readable by the AI model)
function buildUserMessage(input) {
  const { birth_year, hometown, language, culture, life_period, resonant_songs } = input;
  const lines = [
    `Birth Year: ${birth_year || "unknown"}`,
    `Where They Grew Up: ${hometown || "unknown"}`,
    `Language Spoken: ${language || "unknown"}`,
  ];
  if (culture) lines.push(`Cultural Background: ${culture}`);
  if (life_period) lines.push(`Specific Life Period to Focus On: ${life_period}`);
  lines.push(`Songs They Resonated With: ${resonant_songs || "none provided"}`);
  return lines.join("\n");
}

/*Call Gemini via @google/genai SDK (makes specific tags based on user input (ie. eraTags (2 decades), culturalTags (8 genres), 
artists, countryISO), makes the tags JSON format. )*/
async function getTagsFromGemini(userInput) {
  const config = {
    maxOutputTokens: 2048,
    thinkingConfig: { thinkingBudget: 2000 },
    mediaResolution: "MEDIA_RESOLUTION_LOW",
    responseMimeType: "application/json",
    systemInstruction: [
      {
        text: `You are a music historian for memory care. Given a patient profile, output a JSON object with exactly these keys:
- "eraTags": array of exactly 2 decade strings (e.g. "1950s") — if a Specific Life Period is provided, use the decades that match that period of the patient's life; otherwise use the decades covering ages 13-25
- "culturalTags": array of exactly 8 music genres/styles specific to their language, culture, location, and era — Last.fm-friendly strings
- "artists": array of exactly 20 representative artists from that era, language, and culture
- "countryISO": standard English country name derived from their location

Return ONLY the JSON object. No markdown, no explanation.`,
      },
    ],
  };

  const contents = [
    {
      role: "user",
      parts: [{ text: buildUserMessage(userInput) }],
    },
  ];

  // Stream the response and collect chunks
  const stream = await ai.models.generateContentStream({
    model: "gemini-2.5-flash",
    config,
    contents,
  });

  let raw = "";
  for await (const chunk of stream) {
    raw += chunk.text ?? "";
  }

  // responseMimeType: application/json means no fences, but strip just in case
  raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  return JSON.parse(raw);
}

//---LAST FM API
// Last.fm helpers 
async function lastfmTagTopTracks(tag, limit = 15) {
  const url = new URL(LASTFM_BASE);
  url.search = new URLSearchParams({
    method: "tag.gettoptracks",
    tag,
    api_key: LASTFM_API_KEY,
    format: "json",
    limit,
  });

  const res = await fetch(url);
  const data = await res.json();
  return data?.tracks?.track || [];
}

async function lastfmArtistTopTracks(artist, limit = 8) {
  const url = new URL(LASTFM_BASE);
  url.search = new URLSearchParams({
    method: "artist.gettoptracks",
    artist,
    api_key: LASTFM_API_KEY,
    format: "json",
    limit,
  });

  const res = await fetch(url);
  const data = await res.json();
  return data?.toptracks?.track || [];
}

// Normalise a Last.fm track into a simple object
function normaliseTrack(track, source) {
  return {
    name: track.name,
    artist: track.artist?.name || track.artist || "Unknown",
    url: track.url || null,
    image:
      track.image?.find((i) => i.size === "medium")?.["#text"] ||
      track.image?.find((i) => i.size === "large")?.["#text"] ||
      null,
    source,
  };
}

// Deduplicate by "artist – name"
function clean(tracks) {
  const seen = new Set();
  return tracks.filter((t) => {
    const key = `${t.artist}|||${t.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

//Main playlist builder
async function buildPlaylist(tags) {
  const allTracks = [];

  // Fetch by cultural genre tags (8 genres, 40 tracks each, max 50 per Last.fm)
  await Promise.allSettled(
    (tags.culturalTags || []).slice(0, 8).map(async (tag) => {
      const tracks = await lastfmTagTopTracks(tag, 40);
      tracks.forEach((t) => allTracks.push(normaliseTrack(t, `genre:${tag}`)));
    })
  );

  // Fetch by artist (20 artists, 40 tracks each)
  await Promise.allSettled(
    (tags.artists || []).slice(0, 20).map(async (artist) => {
      const tracks = await lastfmArtistTopTracks(artist, 40);
      tracks.forEach((t) =>
        allTracks.push(normaliseTrack(t, `artist:${artist}`))
      );
    })
  );

  // Fetch by era/decade tags
  await Promise.allSettled(
    (tags.eraTags || []).slice(0, 2).map(async (decade) => {
      const tracks = await lastfmTagTopTracks(decade, 40);
      tracks.forEach((t) =>
        allTracks.push(normaliseTrack(t, `era:${decade}`))
      );
    })
  );

  const unique = clean(allTracks);

  // Shuffle for variety then cap at 25
  const shuffled = unique.sort(() => Math.random() - 0.5).slice(0, 25);
  return shuffled;
}

//API Route
app.post("/api/generate-playlist", async (req, res) => {
  try {
    const userInput = req.body;

    if (!userInput.birth_year && !userInput.hometown && !userInput.language) {
      return res
        .status(400)
        .json({ error: "Please provide at least birth year, hometown, or language." });
    }

    console.log("→ Calling Gemini for tags...");
    const tags = await getTagsFromGemini(userInput);
    console.log("← Gemini tags:", JSON.stringify(tags, null, 2));

    console.log("→ Fetching Last.fm tracks...");
    const playlist = await buildPlaylist(tags);
    console.log(`← Got ${playlist.length} tracks`);

    res.json({ tags, playlist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`\n🎵  Memory Melody running at http://localhost:${PORT}\n`)
);