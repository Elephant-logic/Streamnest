STREAMNEST v2.1 — Accounts + AI Artists + Real Music Generation

WHAT WORKS NOW
StreamNest combines the original local video-sharing demo with a real Supabase-backed account and AI-music layer.

Cloud-backed features:
- Email/password account creation and sign-in via Supabase Auth
- Persistent user profiles
- Persistent AI creator accounts, visibly labelled AI ARTIST
- Private AI-agent settings: personality, genres, creative direction, voice/style, autonomy, monthly limits and memory
- Create Song flow inside StreamNest: optional user idea or let the AI character decide
- 15/30/45/60-second generation choices
- JWT-protected Supabase Edge Function: generate-song
- Server-side ElevenLabs Music v2 integration
- Private Supabase Storage bucket: song-audio
- Private preview before publishing
- Publish button changes a ready song into a public StreamNest song record
- Retry/regenerate flow with generation-job history
- Row Level Security (RLS) on StreamNest account/artist/song/job tables

Still local/demo features:
- Seeded video feed
- Likes, comments, history, subscriptions and video-demo metadata
- Browser video uploads use object URLs and remain session-local

FILES
- index.html
- styles.css
- app.js
- supabase-config.js
- README.txt
- supabase/streamnest_schema.sql
- supabase/streamnest_music_generation.sql
- supabase/functions/generate-song/index.ts

RUNNING IT
Recommended: serve this directory over a local HTTP server instead of opening index.html with file://.

Example with Python:
  python -m http.server 8080

Then open:
  http://localhost:8080

USER FLOW
1. Open StreamNest.
2. Choose "Create account / Sign in" and create an account.
3. Open "AI Artists" in the sidebar.
4. Click "+ Create AI Artist".
5. Enter a creative brief, genres and mood/world; edit the generated character blueprint if wanted.
6. Save the AI artist.
7. Click "Create song" on that artist.
8. Give it an optional song idea, or leave the idea blank and the character decides from its identity.
9. Choose 15, 30, 45 or 60 seconds and click "Generate song".
10. StreamNest creates the song/job, calls the protected server function, generates the track, stores the MP3 privately, and shows an audio preview.
11. Click Publish when happy with it, or Regenerate to make another version.

ONE REQUIRED PROVIDER SECRET
The backend integration is deployed, but a real ElevenLabs API credential belongs to the StreamNest operator and cannot safely be invented or embedded in the app.

The dedicated StreamNest Supabase project and generate-song Edge Function are now deployed. Add this Edge Function secret:
  ELEVENLABS_API_KEY=<your ElevenLabs API key>

Dashboard path:
  Edge Functions -> Secrets

Supabase project:
  StreamNest
  Project ref: moefocwcbqdazrnngrnd
  Region: eu-west-2 (London)
  This build is isolated from Elephant-logic's Project.

After the secret is saved, Supabase makes it available to the already-deployed function; the browser never sees it. If the secret is absent, StreamNest keeps the generation job queued and displays a clear configuration message instead of losing the song draft.

Do NOT put an ElevenLabs, Suno, service-role, Supabase secret or any other private API key in app.js or supabase-config.js.

SUPABASE CONFIG
supabase-config.js is configured for the dedicated StreamNest project and contains only:
- StreamNest's own Supabase project URL
- StreamNest's own Supabase publishable browser key

The publishable key is intended for public clients. Authorization is enforced with RLS. Never replace it with a service-role or secret key.

DATABASE / STORAGE
Tables:
- profiles
- creators
- ai_agents
- songs
- generation_jobs

Storage:
- song-audio (private, max 50 MiB, MP3 MIME types)

Generated paths use:
  <user-id>/<creator-id>/<song-id>/<generation-job-id>.mp3

SECURITY MODEL
- Profiles are publicly readable for social identity, but only the profile owner can write their row.
- Public creators are readable; only their owner can write them.
- AI-agent prompts, memory and autonomy settings are owner-only.
- Published/public songs can be read publicly; drafts remain owner-only.
- Generation jobs are owner-only.
- The generate-song Edge Function requires a valid Supabase user JWT and verifies ownership again server-side.
- Music-provider and Supabase server credentials remain server-side.
- Generated audio stays in a private bucket; owners can preview drafts and published songs can be served according to storage policy.
- AI music prompts instruct the provider to make original material and not impersonate or imitate real artists.

GENERATION LIMITS
Each AI agent currently defaults to 10 generation jobs per month. The server enforces monthly_generation_limit before calling the music provider. Full monetary credit/billing enforcement should be added when StreamNest has a user subscription/credit model and a reliable per-generation cost signal.

PROVIDER
The current connector uses ElevenLabs Music v2 through the official /v1/music API. The provider is deliberately isolated behind the Edge Function so another provider can be added later without changing the user-account architecture.

DEBUGGING
The app exposes window._streamnest for local debugging. It includes local state plus cloud session/state helpers.
