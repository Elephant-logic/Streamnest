import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.112.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function firstKey(dictionaryName: string, legacyName: string) {
  const raw = Deno.env.get(dictionaryName)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.default) return parsed.default as string
      const value = Object.values(parsed)[0]
      if (typeof value === 'string') return value
    } catch (_) {
      // Fall back to the legacy environment variable below.
    }
  }
  return Deno.env.get(legacyName) || ''
}

function safeErrorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value || 'Unknown error')
  return message.slice(0, 900)
}

function buildProviderPrompt(creator: any, agent: any, job: any) {
  const genres = Array.isArray(agent?.genres) && agent.genres.length ? agent.genres.join(', ') : 'original contemporary music'
  const concept = String(job.concept || '').trim()
  const base = String(job.prompt || '').trim()
  const voice = String(agent?.voice_style || '').trim()
  const direction = String(agent?.creative_direction || '').trim()
  const personality = String(agent?.personality || '').trim()

  return [
    `Create a fully original song for the fictional AI artist ${creator.name}.`,
    `Genres: ${genres}.`,
    concept ? `Song concept: ${concept}.` : '',
    direction ? `Creative direction: ${direction}.` : '',
    voice ? `Vocal and production character: ${voice}.` : '',
    personality ? `Artist personality: ${personality}.` : '',
    base ? `Additional brief: ${base}.` : '',
    'Use original melodies, lyrics, arrangement and production. Do not imitate, clone, impersonate, or name any real artist, band, song, or copyrighted character. Do not claim the fictional artist is human.',
    'Give the song a clear beginning, development and ending appropriate to its duration.'
  ].filter(Boolean).join(' ').slice(0, 4100)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const secretKey = firstKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !secretKey) return json({ error: 'Server configuration is incomplete.' }, 500)

  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return json({ error: 'Sign in is required.' }, 401)

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userData, error: userError } = await admin.auth.getUser(token)
  const user = userData?.user
  if (userError || !user) return json({ error: 'Your session could not be verified.' }, 401)

  let jobId = ''
  let songId = ''
  let generationStarted = false

  try {
    const body = await req.json().catch(() => ({}))
    jobId = typeof body.job_id === 'string' ? body.job_id : ''
    if (!jobId) return json({ error: 'job_id is required.' }, 400)

    const { data: job, error: jobError } = await admin
      .from('generation_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('owner_user_id', user.id)
      .maybeSingle()
    if (jobError) throw jobError
    if (!job) return json({ error: 'Generation job not found.' }, 404)
    songId = job.song_id || ''
    if (!songId) return json({ error: 'Generation job has no song.' }, 400)

    const [creatorRes, agentRes, songRes] = await Promise.all([
      admin.from('creators').select('*').eq('id', job.creator_id).eq('owner_user_id', user.id).maybeSingle(),
      admin.from('ai_agents').select('*').eq('creator_id', job.creator_id).eq('owner_user_id', user.id).maybeSingle(),
      admin.from('songs').select('*').eq('id', songId).eq('owner_user_id', user.id).maybeSingle(),
    ])
    if (creatorRes.error) throw creatorRes.error
    if (agentRes.error) throw agentRes.error
    if (songRes.error) throw songRes.error
    const creator = creatorRes.data
    const agent = agentRes.data
    const song = songRes.data
    if (!creator || creator.creator_type !== 'ai') return json({ error: 'This job is not attached to your AI artist.' }, 403)
    if (!agent) return json({ error: 'AI artist settings are missing.' }, 400)
    if (!song || song.creator_id !== creator.id) return json({ error: 'Song ownership check failed.' }, 403)

    if (job.status === 'succeeded' && song.audio_path && ['ready', 'published'].includes(song.status)) {
      return json({ ok: true, song_id: song.id, audio_path: song.audio_path, provider: song.provider || 'elevenlabs', already_generated: true })
    }
    if (job.status === 'running') return json({ error: 'This song is already generating.' }, 409)

    const monthlyLimit = Math.max(0, Number(agent.monthly_generation_limit || 0))
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const { count, error: countError } = await admin
      .from('generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', user.id)
      .eq('creator_id', creator.id)
      .gte('created_at', monthStart.toISOString())
      .in('status', ['queued', 'running', 'succeeded'])
    if (countError) throw countError
    if (monthlyLimit === 0 || Number(count || 0) > monthlyLimit) {
      await admin.from('generation_jobs').update({
        status: 'failed',
        provider: 'elevenlabs',
        error_message: `Monthly generation limit reached (${monthlyLimit}).`,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('owner_user_id', user.id)
      return json({ error: `This artist has reached its monthly generation limit of ${monthlyLimit}.`, code: 'generation_limit' }, 429)
    }

    const elevenLabsKey = Deno.env.get('ELEVENLABS_API_KEY') || ''
    if (!elevenLabsKey) {
      await admin.from('generation_jobs').update({
        status: 'queued',
        provider: 'elevenlabs',
        error_message: 'ELEVENLABS_API_KEY has not been configured on the StreamNest server yet.',
        updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('owner_user_id', user.id)
      await admin.from('songs').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', song.id).eq('owner_user_id', user.id)
      return json({ error: 'StreamNest music generation is ready, but the ElevenLabs server key still needs to be added.', code: 'provider_not_configured' }, 503)
    }

    const requestedSeconds = Number(job.requested_duration_seconds || 30)
    const durationSeconds = Math.max(10, Math.min(60, Number.isFinite(requestedSeconds) ? Math.round(requestedSeconds) : 30))
    const providerPrompt = buildProviderPrompt(creator, agent, job)

    const now = new Date().toISOString()
    const { error: runningError } = await admin.from('generation_jobs').update({
      status: 'running',
      provider: 'elevenlabs',
      error_message: null,
      updated_at: now,
    }).eq('id', job.id).eq('owner_user_id', user.id)
    if (runningError) throw runningError
    const { error: songRunningError } = await admin.from('songs').update({
      status: 'generating',
      provider: 'elevenlabs',
      updated_at: now,
    }).eq('id', song.id).eq('owner_user_id', user.id)
    if (songRunningError) throw songRunningError
    generationStarted = true

    const providerResponse = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': elevenLabsKey,
      },
      body: JSON.stringify({
        prompt: providerPrompt,
        music_length_ms: durationSeconds * 1000,
        model_id: 'music_v2',
        force_instrumental: false,
      }),
    })

    if (!providerResponse.ok) {
      const providerText = (await providerResponse.text()).slice(0, 700)
      throw new Error(`Music provider error ${providerResponse.status}: ${providerText || providerResponse.statusText}`)
    }

    const audioBytes = new Uint8Array(await providerResponse.arrayBuffer())
    if (!audioBytes.byteLength) throw new Error('The music provider returned an empty audio file.')
    const providerSongId = providerResponse.headers.get('song-id')
    const audioPath = `${user.id}/${creator.id}/${song.id}/${job.id}.mp3`

    const { error: uploadError } = await admin.storage.from('song-audio').upload(audioPath, audioBytes, {
      contentType: 'audio/mpeg',
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) throw uploadError

    const completedAt = new Date().toISOString()
    const { error: songDoneError } = await admin.from('songs').update({
      audio_path: audioPath,
      audio_url: null,
      provider: 'elevenlabs',
      provider_job_id: providerSongId,
      duration_seconds: durationSeconds,
      status: 'ready',
      updated_at: completedAt,
    }).eq('id', song.id).eq('owner_user_id', user.id)
    if (songDoneError) throw songDoneError

    const { error: jobDoneError } = await admin.from('generation_jobs').update({
      status: 'succeeded',
      provider: 'elevenlabs',
      error_message: null,
      updated_at: completedAt,
    }).eq('id', job.id).eq('owner_user_id', user.id)
    if (jobDoneError) throw jobDoneError

    return json({ ok: true, song_id: song.id, audio_path: audioPath, provider: 'elevenlabs', duration_seconds: durationSeconds })
  } catch (error) {
    console.error('generate-song failed', error)
    const message = safeErrorMessage(error)
    if (generationStarted && jobId) {
      await admin.from('generation_jobs').update({
        status: 'failed',
        provider: 'elevenlabs',
        error_message: message,
        updated_at: new Date().toISOString(),
      }).eq('id', jobId).eq('owner_user_id', user.id)
      if (songId) {
        await admin.from('songs').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', songId).eq('owner_user_id', user.id)
      }
    }
    return json({ error: message, code: 'generation_failed' }, 500)
  }
})
