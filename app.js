/* StreamNest — Single-file app logic. Uses localStorage for persistence and object URLs for uploads. */
(function(){
  'use strict';

  // Storage key and schema version
  const STORE_KEY = 'STREAMNEST_v1';
  const DEFAULT_STATE = {
    version:1,
    profile:{username:'Streamer', handle:'@streamer', avatarColor:'#FF6B5A',bio:'Welcome to my StreamNest profile',joined:Date.now()},
    settings:{darkMode:true,autoplay:true,compact:false,reduceMotion:false,language:'en',pausedHistory:false},
    sidebarCollapsed:false,
    searches:[],
    notifications:[],
    subscriptions:[],
    playlists:[],
    creators:[],
    videos:[],
    comments:{},
    history:[],
    uploads:[],
    drafts:[],
  };

  // Helpers: safe localStorage
  function loadState(){
    try{
      const raw = localStorage.getItem(STORE_KEY);
      if(!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
      const parsed = JSON.parse(raw);
      if(!parsed || typeof parsed !== 'object') throw new Error('bad');
      // Merge safely
      const merged = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), parsed);
      // Ensure arrays
      merged.searches = Array.isArray(merged.searches) ? merged.searches : [];
      merged.notifications = Array.isArray(merged.notifications) ? merged.notifications : [];
      merged.subscriptions = Array.isArray(merged.subscriptions) ? merged.subscriptions : [];
      merged.playlists = Array.isArray(merged.playlists) ? merged.playlists : [];
      merged.creators = Array.isArray(merged.creators) ? merged.creators : [];
      merged.videos = Array.isArray(merged.videos) ? merged.videos : [];
      merged.comments = typeof merged.comments === 'object' && merged.comments ? merged.comments : {};
      merged.history = Array.isArray(merged.history) ? merged.history : [];
      merged.uploads = Array.isArray(merged.uploads) ? merged.uploads : [];
      merged.drafts = Array.isArray(merged.drafts) ? merged.drafts : [];
      return merged;
    }catch(e){
      console.error('Storage load error, recovering:',e);
      // Back up corrupted data to allow user export later
      try{localStorage.setItem(STORE_KEY+'_backup_'+Date.now(), localStorage.getItem(STORE_KEY) || '');}catch(e){}
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  }
  function saveState(){
    try{
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      checkStorageQuota();
    }catch(e){
      console.warn('Storage save failed',e);
      alert('Unable to save data: localStorage quota likely exceeded. Consider exporting or removing old items.');
    }
  }

  function checkStorageQuota(){
    try{
      const used = new Blob([localStorage.getItem(STORE_KEY) || '']).size;
      // Warn at 85% of 5MB approx
      if(used > 4200000){
        showToast('Storage near capacity. Export or remove items to avoid data loss.');
      }
    }catch(e){}
  }

  // In-memory state
  let state = loadState();

  // StreamNest v2 cloud layer (Supabase Auth + persistent AI artist records)
  const cloud = {
    client:null,
    user:null,
    profile:null,
    creators:[],
    agents:{},
    songs:[],
    jobs:[],
    audioUrls:{},
    ready:false,
    error:null
  };

  function cloudConfigured(){
    const cfg = window.STREAMNEST_CONFIG;
    return !!(cfg && cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase && window.supabase.createClient);
  }

  async function initCloud(){
    if(!cloudConfigured()){
      cloud.error = 'Cloud configuration or Supabase client is unavailable.';
      cloud.ready = true;
      updateAuthUI();
      return;
    }
    try{
      const cfg = window.STREAMNEST_CONFIG;
      cloud.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
      const {data, error} = await cloud.client.auth.getSession();
      if(error) throw error;
      cloud.user = data.session ? data.session.user : null;
      if(cloud.user) await refreshCloudState();
      cloud.ready = true;
      updateAuthUI();
      cloud.client.auth.onAuthStateChange((_event, session)=>{
        cloud.user = session ? session.user : null;
        setTimeout(async ()=>{
          if(cloud.user) await refreshCloudState();
          else resetCloudState();
          updateAuthUI();
          const route = document.body.getAttribute('data-route');
          if(route === 'profile') renderRoute('profile');
          if(route === 'ai-artists') renderRoute('ai-artists');
        },0);
      });
    }catch(err){
      console.error('StreamNest cloud init failed', err);
      cloud.error = err.message || String(err);
      cloud.ready = true;
      updateAuthUI();
    }
  }

  function resetCloudState(){
    cloud.profile = null;
    cloud.creators = [];
    cloud.agents = {};
    cloud.songs = [];
    cloud.jobs = [];
    cloud.audioUrls = {};
  }

  function normalizeHandle(value){
    const clean = String(value || '').toLowerCase().replace(/^@+/,'').replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'').slice(0,24) || 'creator';
    return '@' + clean;
  }

  function syncLocalProfile(){
    if(!cloud.profile) return;
    state.profile.username = cloud.profile.username;
    state.profile.handle = cloud.profile.handle;
    state.profile.avatarColor = cloud.profile.avatar_color || state.profile.avatarColor;
    state.profile.bio = cloud.profile.bio || '';
    state.profile.joined = new Date(cloud.profile.joined_at).getTime() || state.profile.joined;
    saveState();
  }

  async function ensureCloudProfile(){
    if(!cloud.client || !cloud.user) return null;
    const {data:existing, error:readError} = await cloud.client.from('profiles').select('*').eq('id', cloud.user.id).maybeSingle();
    if(readError) throw readError;
    if(existing) return existing;
    const emailName = (cloud.user.email || 'streamer').split('@')[0];
    const displayName = (cloud.user.user_metadata && cloud.user.user_metadata.display_name) || emailName || 'Streamer';
    const handle = normalizeHandle(emailName + '_' + cloud.user.id.slice(0,6));
    const {data:created, error:createError} = await cloud.client.from('profiles').insert({
      id:cloud.user.id,
      username:String(displayName).slice(0,60),
      handle,
      bio:'Welcome to my StreamNest profile',
      avatar_color:'#FF6B5A'
    }).select('*').single();
    if(createError) throw createError;
    return created;
  }

  async function refreshCloudState(){
    if(!cloud.client || !cloud.user) return;
    cloud.profile = await ensureCloudProfile();
    const [creatorsRes, agentsRes, songsRes, jobsRes] = await Promise.all([
      cloud.client.from('creators').select('*').eq('owner_user_id', cloud.user.id).order('created_at',{ascending:false}),
      cloud.client.from('ai_agents').select('*').eq('owner_user_id', cloud.user.id),
      cloud.client.from('songs').select('*').eq('owner_user_id', cloud.user.id).order('created_at',{ascending:false}).limit(50),
      cloud.client.from('generation_jobs').select('*').eq('owner_user_id', cloud.user.id).order('created_at',{ascending:false}).limit(100)
    ]);
    if(creatorsRes.error) throw creatorsRes.error;
    if(agentsRes.error) throw agentsRes.error;
    if(songsRes.error) throw songsRes.error;
    if(jobsRes.error) throw jobsRes.error;
    cloud.creators = creatorsRes.data || [];
    cloud.agents = Object.fromEntries((agentsRes.data || []).map(a=>[a.creator_id,a]));
    cloud.songs = songsRes.data || [];
    cloud.jobs = jobsRes.data || [];
    syncLocalProfile();
  }

  function updateAuthUI(){
    if(typeof profileBtn === 'undefined' || !profileBtn) return;
    const initial = profileBtn.querySelector('.avatar-initial');
    if(cloud.user){
      const label = (cloud.profile && cloud.profile.username) || (cloud.user.email || 'User');
      if(initial) initial.textContent = String(label).trim().charAt(0).toUpperCase() || 'U';
      profileBtn.title = cloud.profile ? `${cloud.profile.username} — Account` : 'Signed in';
    }else{
      if(initial) initial.textContent = 'S';
      profileBtn.title = 'Sign in / Profile';
    }
    if(typeof accountBtn !== 'undefined' && accountBtn){
      accountBtn.textContent = cloud.user ? 'Open my account' : 'Create account / Sign in';
    }
  }

  function cloudStatusHtml(){
    if(!cloudConfigured()) return `<div class='provider-note'>Cloud connection is not configured.</div>`;
    if(!cloud.ready) return `<div class='auth-status'>Connecting to StreamNest cloud…</div>`;
    if(cloud.error) return `<div class='provider-note'>Cloud error: ${escapeHtml(cloud.error)}</div>`;
    if(cloud.user) return `<div class='auth-status'><span class='cloud-dot'></span>Signed in as ${escapeHtml(cloud.user.email || 'user')}</div>`;
    return '';
  }

  function renderAuth(){
    const c=document.createElement('div'); c.className='screen-page auth-shell';
    c.innerHTML=`<h2>StreamNest Account</h2>${cloudStatusHtml()}<div class='card auth-card' id='auth-card'></div>`;
    view.appendChild(c);
    const host=c.querySelector('#auth-card');
    if(cloud.user){
      host.innerHTML=`<h3>You're signed in</h3><p class='small'>Your profile and AI artists are stored in StreamNest cloud.</p><div class='profile-actions'><button class='btn btn-primary' id='auth-profile'>Open profile</button><button class='btn' id='auth-signout'>Sign out</button></div>`;
      host.querySelector('#auth-profile').addEventListener('click',()=>setRoute('profile'));
      host.querySelector('#auth-signout').addEventListener('click', async ()=>{ await cloud.client.auth.signOut(); showToast('Signed out'); setRoute('home'); });
      return;
    }
    if(!cloud.client){
      host.innerHTML=`<p>Cloud authentication is unavailable. Check <code>supabase-config.js</code> and your network connection.</p>`;
      return;
    }
    let mode='signup';
    const paint=()=>{
      host.innerHTML=`<div class='auth-tabs'><button class='chip ${mode==='signup'?'active':''}' id='tab-signup'>Create account</button><button class='chip ${mode==='signin'?'active':''}' id='tab-signin'>Sign in</button></div>
        <form id='auth-form' class='form-row'>
          ${mode==='signup'?"<input class='input' id='auth-name' maxlength='60' placeholder='Display name' autocomplete='name' required>":''}
          <input class='input' id='auth-email' type='text' inputmode='text' name='streamnest-email' placeholder='Email address' autocomplete='off' autocapitalize='none' autocorrect='off' spellcheck='false' enterkeyhint='next' required>
          <input class='input' id='auth-password' type='password' placeholder='Password (8+ characters)' minlength='8' autocomplete='off' autocapitalize='none' autocorrect='off' spellcheck='false' enterkeyhint='done' required>
          <label class='small auth-show-password'><input id='auth-show-password' type='checkbox'> Show password</label>
          <button class='btn btn-primary' type='submit'>${mode==='signup'?'Create StreamNest account':'Sign in'}</button>
          <div id='auth-message' class='small'></div>
        </form>`;
      host.querySelector('#tab-signup').addEventListener('click',()=>{mode='signup';paint();});
      host.querySelector('#tab-signin').addEventListener('click',()=>{mode='signin';paint();});
      const passwordInput=host.querySelector('#auth-password');
      const showPassword=host.querySelector('#auth-show-password');
      showPassword.addEventListener('change',()=>{
        passwordInput.type=showPassword.checked?'text':'password';
      });
      host.querySelector('#auth-form').addEventListener('submit', async (e)=>{
        e.preventDefault();
        const message=host.querySelector('#auth-message');
        const email=host.querySelector('#auth-email').value.trim().toLowerCase();
        const password=host.querySelector('#auth-password').value;
        if(!email || !email.includes('@')){
          message.textContent='Enter your email address.';
          host.querySelector('#auth-email').focus();
          return;
        }
        message.textContent = mode==='signup' ? 'Creating account…' : 'Signing in…';
        try{
          if(mode==='signup'){
            const displayName=host.querySelector('#auth-name').value.trim();
            const {data,error}=await cloud.client.auth.signUp({email,password,options:{data:{display_name:displayName}}});
            if(error) throw error;
            if(data.session){
              cloud.user=data.user; await refreshCloudState(); updateAuthUI(); showToast('Account created'); setRoute('profile');
            }else{
              message.textContent='Account created. Check your email to confirm it, then sign in.';
            }
          }else{
            const {data,error}=await cloud.client.auth.signInWithPassword({email,password});
            if(error) throw error;
            cloud.user=data.user; await refreshCloudState(); updateAuthUI(); showToast('Signed in'); setRoute('profile');
          }
        }catch(err){
          console.error('Auth error',err);
          message.textContent=err.message || 'Authentication failed.';
        }
      });
    };
    paint();
  }

  function hashText(value){
    let h=2166136261;
    for(const ch of String(value||'')){ h ^= ch.charCodeAt(0); h = Math.imul(h,16777619); }
    return h>>>0;
  }

  function buildArtistBlueprint(brief, genres, mood){
    const seed=hashText(`${brief}|${genres.join(',')}|${mood}|${Date.now()}`);
    const first=['Neon','Velvet','Lunar','Static','Echo','Glass','Nova','Midnight','Solar','Paper','Chrome','Amber'];
    const second=['Vesper','Arc','Bloom','Signal','Ghost','Harbor','Saint','Circuit','Moth','Mirage','June','Atlas'];
    const traits=['curious and cinematic','restless and introspective','warm but unpredictable','precise, futuristic and emotionally restrained','dreamlike and confessional','playful, strange and rhythm-first'];
    const voices=['intimate layered vocals with textured harmonies','airy lead vocals with sharp rhythmic phrasing','low-key spoken-sung verses opening into melodic hooks','wide cinematic vocals with glitchy backing textures','soft close-mic vocals with an explosive chorus'];
    const palettes=['#FF6B5A','#00E1D6','#7AD6FF','#FFD36B','#D98CFF','#6BFFB3','#FF6BD1'];
    const name=`${first[seed%first.length]} ${second[(seed>>>5)%second.length]}`;
    const genreText=genres.length?genres.join(', '):'electronic pop';
    const personality=traits[(seed>>>9)%traits.length];
    const direction=`Create original ${genreText} music with a ${mood || 'distinctive'} atmosphere. ${brief || 'Build a recognisable catalogue that evolves over time.'}`;
    const voiceStyle=voices[(seed>>>13)%voices.length];
    const handle=normalizeHandle(`${name}_${(seed%4096).toString(36)}`);
    const bio=`An explicitly AI-created StreamNest artist exploring ${genreText}. ${brief || 'Built to develop its own evolving musical identity.'}`;
    return {
      name,handle,bio,personality,creativeDirection:direction,voiceStyle,
      avatarColor:palettes[(seed>>>17)%palettes.length],
      systemPrompt:`You are ${name}, an explicitly AI-generated music artist on StreamNest. Make original work only. Never impersonate a real artist or claim to be human. Your personality is ${personality}. Your creative direction is: ${direction}. Maintain continuity while still experimenting.`
    };
  }

  function openCreateAiArtistPanel(){
    if(!cloud.user){ setRoute('auth'); return; }
    const html=`<h3>Create AI Artist</h3>
      <p class='small'>Character Lab creates a persistent artist blueprint. The music-provider step is queued separately so API secrets never live in the browser.</p>
      <div class='form-row' id='ai-builder'>
        <textarea class='input' id='ai-brief' placeholder='Creative brief — e.g. nocturnal electronic artist inspired by coastal cities'></textarea>
        <input class='input' id='ai-genres' placeholder='Genres, comma separated (e.g. synthpop, ambient)'>
        <input class='input' id='ai-mood' placeholder='Mood / world (e.g. melancholic, neon, hopeful)'>
        <select class='input' id='ai-autonomy'><option value='manual'>Manual approval</option><option value='assisted'>Assisted</option><option value='autonomous'>Autonomous (generation still budget-limited)</option></select>
        <button class='btn btn-primary' id='ai-generate'>Generate character blueprint</button>
        <div id='ai-preview'></div>
      </div>`;
    showPanel(html);
    document.getElementById('ai-generate').addEventListener('click',()=>{
      const brief=document.getElementById('ai-brief').value.trim();
      const genres=document.getElementById('ai-genres').value.split(',').map(s=>s.trim()).filter(Boolean).slice(0,8);
      const mood=document.getElementById('ai-mood').value.trim();
      const autonomy=document.getElementById('ai-autonomy').value;
      const bp=buildArtistBlueprint(brief,genres,mood);
      const preview=document.getElementById('ai-preview');
      preview.innerHTML=`<div class='card' style='margin-top:8px'>
        <div class='ai-meta'><div class='ai-avatar' style='background:${bp.avatarColor}'>${escapeHtml(bp.name.split(' ').map(x=>x[0]).join('').slice(0,2))}</div><div><span class='ai-badge'>✨ AI ARTIST</span><h3 style='margin:6px 0 2px'>${escapeHtml(bp.name)}</h3><div class='small'>${escapeHtml(bp.handle)}</div></div></div>
        <div class='form-row' style='margin-top:12px'>
          <input class='input' id='bp-name' value='${escapeHtml(bp.name)}' placeholder='Artist name'>
          <input class='input' id='bp-handle' value='${escapeHtml(bp.handle)}' placeholder='Handle'>
          <textarea class='input' id='bp-bio'>${escapeHtml(bp.bio)}</textarea>
          <textarea class='input' id='bp-personality'>${escapeHtml(bp.personality)}</textarea>
          <textarea class='input' id='bp-direction'>${escapeHtml(bp.creativeDirection)}</textarea>
          <textarea class='input' id='bp-voice'>${escapeHtml(bp.voiceStyle)}</textarea>
          <button class='btn btn-primary' id='bp-save'>Create this AI artist</button>
          <div class='small' id='bp-message'></div>
        </div></div>`;
      document.getElementById('bp-save').addEventListener('click',async()=>{
        const message=document.getElementById('bp-message'); message.textContent='Saving artist…';
        try{
          const finalBp={...bp,
            name:document.getElementById('bp-name').value.trim(),
            handle:normalizeHandle(document.getElementById('bp-handle').value),
            bio:document.getElementById('bp-bio').value.trim(),
            personality:document.getElementById('bp-personality').value.trim(),
            creativeDirection:document.getElementById('bp-direction').value.trim(),
            voiceStyle:document.getElementById('bp-voice').value.trim()
          };
          finalBp.systemPrompt=`You are ${finalBp.name}, an explicitly AI-generated music artist on StreamNest. Make original work only. Never impersonate a real artist or claim to be human. Your personality is ${finalBp.personality}. Your creative direction is: ${finalBp.creativeDirection}. Maintain continuity while still experimenting.`;
          await saveAiArtist(finalBp,genres,autonomy);
          hidePanel(); showToast(`${finalBp.name} created`); setRoute('ai-artists');
        }catch(err){ console.error(err); message.textContent=err.message || 'Could not create artist.'; }
      });
    });
  }

  async function saveAiArtist(bp, genres, autonomy){
    if(!cloud.user) throw new Error('Sign in first.');
    const handle=normalizeHandle(bp.handle || bp.name + '_' + Date.now().toString(36).slice(-4));
    const {data:creator,error:creatorError}=await cloud.client.from('creators').insert({
      owner_user_id:cloud.user.id,creator_type:'ai',name:bp.name,handle,avatar_color:bp.avatarColor,bio:bp.bio,is_public:true
    }).select('*').single();
    if(creatorError) throw creatorError;
    const {error:agentError}=await cloud.client.from('ai_agents').insert({
      creator_id:creator.id,owner_user_id:cloud.user.id,personality:bp.personality,genres,creative_direction:bp.creativeDirection,
      voice_style:bp.voiceStyle,system_prompt:bp.systemPrompt,autonomy_level:autonomy,monthly_generation_limit:10,generation_budget_cents:0,
      memory:{origin:'StreamNest Character Lab',created_from_brief:true}
    });
    if(agentError){ await cloud.client.from('creators').delete().eq('id',creator.id); throw agentError; }
    await refreshCloudState();
    return creator;
  }

  function makeAiSongDraft(creator, agent, idea){
    const genre=(agent && agent.genres && agent.genres[0]) || 'electronic';
    const seed=hashText(`${creator.name}|${idea||''}|${Date.now()}`);
    const wordsA=['Afterglow','Satellite','Glass','Signal','Tide','Static','Gravity','Neon','Memory','Horizon','Velvet','Electric'];
    const wordsB=['Hearts','Weather','Rooms','Dreams','Lines','Ocean','Hours','Ghosts','Light','City','Echoes','Sky'];
    const title=`${wordsA[seed%wordsA.length]} ${wordsB[(seed>>>7)%wordsB.length]}`;
    const fallback=`${creator.name} decides what to make next from its established ${genre} identity and creative direction.`;
    const concept=String(idea||'').trim() || fallback;
    const prompt=`Make the next original ${genre} release for ${creator.name}. Concept: ${concept}. ${agent ? 'Creative direction: '+agent.creative_direction+'. Voice/style: '+agent.voice_style+'. Personality: '+agent.personality+'.' : ''}`;
    return {title,concept,prompt};
  }

  async function getFunctionErrorMessage(error){
    let message=(error && error.message) || 'Song generation failed.';
    try{
      if(error && error.context && typeof error.context.json==='function'){
        const payload=await error.context.json();
        message=(payload && (payload.error || payload.message)) || message;
      }
    }catch(_){ }
    return message;
  }

  async function invokeSongGeneration(jobId){
    if(!cloud.client || !cloud.user) throw new Error('Sign in first.');
    const {data,error}=await cloud.client.functions.invoke('generate-song',{body:{job_id:jobId}});
    if(error) throw new Error(await getFunctionErrorMessage(error));
    if(data && data.error) throw new Error(data.error);
    return data;
  }

  async function createAndGenerateSong(creator, agent, options={}){
    if(!cloud.user) return setRoute('auth');
    const duration=Math.max(10,Math.min(60,Number(options.duration)||30));
    const draft=makeAiSongDraft(creator,agent,options.idea);
    const {data:song,error:songError}=await cloud.client.from('songs').insert({
      owner_user_id:cloud.user.id,
      creator_id:creator.id,
      title:draft.title,
      description:draft.concept,
      status:'draft',
      is_public:false
    }).select('*').single();
    if(songError) throw songError;
    const {data:job,error:jobError}=await cloud.client.from('generation_jobs').insert({
      owner_user_id:cloud.user.id,
      creator_id:creator.id,
      song_id:song.id,
      provider:'elevenlabs',
      concept:draft.concept,
      prompt:draft.prompt,
      requested_duration_seconds:duration,
      status:'queued'
    }).select('*').single();
    if(jobError){
      await cloud.client.from('songs').delete().eq('id',song.id).eq('owner_user_id',cloud.user.id);
      throw jobError;
    }
    try{
      const result=await invokeSongGeneration(job.id);
      await refreshCloudState();
      showToast(`“${draft.title}” is ready to preview`);
      return result;
    }catch(err){
      await refreshCloudState();
      throw err;
    }finally{
      if(document.body.getAttribute('data-route')==='ai-artists') renderRoute('ai-artists');
    }
  }

  function openCreateSongPanel(creator, agent){
    if(!cloud.user){setRoute('auth');return;}
    const genres=((agent&&agent.genres)||[]).join(', ') || 'the artist’s established style';
    showPanel(`<h3>Create a song — ${escapeHtml(creator.name)}</h3>
      <p class='small'>Give the artist an idea, or leave it blank and let the character decide from its personality and creative direction.</p>
      <div class='form-row'>
        <label class='small' for='song-idea'>Optional idea</label>
        <textarea class='input' id='song-idea' rows='4' placeholder='e.g. A restless night drive through a rain-soaked city'></textarea>
        <label class='small' for='song-duration'>Demo length</label>
        <select class='input' id='song-duration'><option value='15'>15 seconds</option><option value='30' selected>30 seconds</option><option value='45'>45 seconds</option><option value='60'>60 seconds</option></select>
        <div class='small'>Character genres: ${escapeHtml(genres)}. The server also adds the artist's personality, voice style and creative direction to the generation brief.</div>
        <button class='btn btn-primary' id='generate-song-now'>Generate song</button>
        <div class='small' id='song-generate-message'></div>
      </div>`);
    const btn=document.getElementById('generate-song-now');
    const msg=document.getElementById('song-generate-message');
    btn.addEventListener('click',async()=>{
      btn.disabled=true; btn.textContent='Generating…'; msg.textContent='Creating the song and sending it to the music generator…';
      try{
        await createAndGenerateSong(creator,agent,{idea:document.getElementById('song-idea').value.trim(),duration:Number(document.getElementById('song-duration').value)});
        hidePanel();
      }catch(err){
        msg.textContent=err.message || 'Song generation failed.';
        btn.disabled=false; btn.textContent='Try again';
      }
    });
  }

  async function publishSong(song){
    if(!cloud.user || !song.audio_path || song.status!=='ready') return;
    const {error}=await cloud.client.from('songs').update({
      status:'published',is_public:true,published_at:new Date().toISOString(),updated_at:new Date().toISOString()
    }).eq('id',song.id).eq('owner_user_id',cloud.user.id);
    if(error) throw error;
    await refreshCloudState();
    showToast(`“${song.title}” published`);
    if(document.body.getAttribute('data-route')==='ai-artists') renderRoute('ai-artists');
  }

  async function retrySongGeneration(song){
    if(!cloud.user) throw new Error('Sign in first.');
    const latest=cloud.jobs.find(j=>j.song_id===song.id);
    let job=latest;
    if(!job || job.status==='failed' || job.status==='cancelled' || job.status==='succeeded'){
      const creator=cloud.creators.find(c=>c.id===song.creator_id);
      const agent=cloud.agents[song.creator_id];
      const draft=makeAiSongDraft(creator||{name:'AI artist'},agent,song.description);
      const {data,error}=await cloud.client.from('generation_jobs').insert({
        owner_user_id:cloud.user.id,creator_id:song.creator_id,song_id:song.id,provider:'elevenlabs',
        concept:(latest&&latest.concept)||song.description||draft.concept,
        prompt:(latest&&latest.prompt)||draft.prompt,
        requested_duration_seconds:(latest&&latest.requested_duration_seconds)||song.duration_seconds||30,
        status:'queued'
      }).select('*').single();
      if(error) throw error;
      job=data;
      await cloud.client.from('songs').update({status:'draft',updated_at:new Date().toISOString()}).eq('id',song.id).eq('owner_user_id',cloud.user.id);
    }
    const result=await invokeSongGeneration(job.id);
    await refreshCloudState();
    showToast(`“${song.title}” is ready to preview`);
    if(document.body.getAttribute('data-route')==='ai-artists') renderRoute('ai-artists');
    return result;
  }

  async function resolveSongAudio(song, audioEl){
    if(!song.audio_path || !cloud.client || !audioEl) return;
    try{
      let signed=cloud.audioUrls[song.audio_path];
      if(!signed){
        const {data,error}=await cloud.client.storage.from('song-audio').createSignedUrl(song.audio_path,3600);
        if(error) throw error;
        signed=data && data.signedUrl;
        if(signed) cloud.audioUrls[song.audio_path]=signed;
      }
      if(signed) audioEl.src=signed;
    }catch(err){
      const holder=audioEl.closest('.song-audio-wrap');
      if(holder) holder.insertAdjacentHTML('beforeend',`<div class='small provider-note'>Could not load preview: ${escapeHtml(err.message||String(err))}</div>`);
    }
  }

  async function deleteAiArtist(creator){
    if(!cloud.user || !confirm(`Delete ${creator.name} and its drafts?`)) return;
    const {error}=await cloud.client.from('creators').delete().eq('id',creator.id).eq('owner_user_id',cloud.user.id);
    if(error){showToast(error.message);return;}
    await refreshCloudState();
    showToast('AI artist deleted');
    renderRoute('ai-artists');
  }

  function renderAiArtists(){
    const c=document.createElement('div'); c.className='screen-page';
    c.innerHTML=`<div class='ai-toolbar'><div><h2 style='margin-bottom:4px'>AI Artists</h2><div class='small'>Create a character, generate original music from its identity, preview it privately, then publish.</div></div><button class='btn btn-primary' id='new-ai-artist'>＋ Create AI Artist</button></div>${cloudStatusHtml()}<div id='ai-artist-content'></div>`;
    view.appendChild(c);
    c.querySelector('#new-ai-artist').addEventListener('click',openCreateAiArtistPanel);
    const host=c.querySelector('#ai-artist-content');
    if(!cloud.user){
      host.innerHTML=`<div class='empty-state'><h3>Sign in to create an AI artist</h3><p>Your artist's personality, music and generation settings will persist in the cloud.</p><button class='btn btn-primary' id='ai-signin'>Create account / Sign in</button></div>`;
      host.querySelector('#ai-signin').addEventListener('click',()=>setRoute('auth'));
      return;
    }
    host.innerHTML='<div class="small">Loading your artists…</div>';
    refreshCloudState().then(()=>{
      if(document.body.getAttribute('data-route')!=='ai-artists') return;
      const artists=cloud.creators.filter(x=>x.creator_type==='ai');
      host.innerHTML='';
      if(!artists.length){
        host.innerHTML=`<div class='empty-state'><h3>No AI artists yet</h3><p>Create a character, then generate its first song.</p></div>`;
      }else{
        const grid=document.createElement('div'); grid.className='ai-grid';
        artists.forEach(creator=>{
          const agent=cloud.agents[creator.id];
          const count=cloud.songs.filter(s=>s.creator_id===creator.id).length;
          const published=cloud.songs.filter(s=>s.creator_id===creator.id&&s.status==='published').length;
          const el=document.createElement('article'); el.className='card ai-card';
          el.innerHTML=`<div class='ai-meta'><div class='ai-avatar' style='background:${escapeHtml(creator.avatar_color || '#00E1D6')}'>${escapeHtml(creator.name.split(' ').map(x=>x[0]).join('').slice(0,2))}</div><div><span class='ai-badge'>✨ AI ARTIST</span><h3 style='margin:6px 0 2px'>${escapeHtml(creator.name)}</h3><div class='small'>${escapeHtml(creator.handle)} • ${count} song${count===1?'':'s'} • ${published} published</div></div></div>
            <p class='small' style='margin-top:10px'>${escapeHtml(creator.bio || '')}</p>
            <div class='ai-genres'>${((agent&&agent.genres)||[]).map(g=>`<span class='chip'>${escapeHtml(g)}</span>`).join('')}</div>
            <div class='small' style='margin-top:9px'><strong>Personality:</strong> ${escapeHtml((agent&&agent.personality)||'Not set')}</div>
            <div class='small' style='margin-top:5px'><strong>Autonomy:</strong> ${escapeHtml((agent&&agent.autonomy_level)||'manual')} • Monthly generation limit: ${Number((agent&&agent.monthly_generation_limit)||0)}</div>
            <div class='ai-card-actions'><button class='btn btn-primary create-song'>♫ Create song</button><button class='btn delete-ai'>Delete</button></div>`;
          el.querySelector('.create-song').addEventListener('click',()=>openCreateSongPanel(creator,agent));
          el.querySelector('.delete-ai').addEventListener('click',()=>deleteAiArtist(creator));
          grid.appendChild(el);
        });
        host.appendChild(grid);
      }

      const section=document.createElement('section'); section.className='song-library';
      section.innerHTML=`<div class='song-section-heading'><div><h3>Your AI songs</h3><div class='small'>Generated audio stays private until you press Publish.</div></div></div>`;
      const list=document.createElement('div'); list.className='song-list';
      if(!cloud.songs.length) list.innerHTML=`<div class='empty-state'>No songs yet. Choose an AI artist and press Create song.</div>`;
      cloud.songs.forEach(song=>{
        const creator=cloud.creators.find(x=>x.id===song.creator_id);
        const latestJob=cloud.jobs.find(j=>j.song_id===song.id);
        const row=document.createElement('article'); row.className='card song-row';
        const status=String(song.status||'draft');
        const statusLabel=status==='ready'?'READY TO PUBLISH':status.toUpperCase();
        const errorNote=latestJob&&latestJob.error_message?`<div class='small song-error'>${escapeHtml(latestJob.error_message)}</div>`:'';
        row.innerHTML=`<div class='song-main'><div class='song-title-line'><div><div class='song-title'>${escapeHtml(song.title)}</div><div class='small'>${escapeHtml(creator?creator.name:'AI artist')} • ${song.duration_seconds?escapeHtml(String(song.duration_seconds))+' sec • ':''}${timeAgo(new Date(song.created_at).getTime())}</div></div><span class='generation-state' data-status='${escapeHtml(status)}'>${escapeHtml(statusLabel)}</span></div>
          <div class='small song-concept'>${escapeHtml(song.description||'')}</div>
          ${errorNote}
          <div class='song-audio-wrap'>${song.audio_path?`<audio class='music-player' controls preload='metadata'></audio>`:`<div class='small'>${status==='generating'?'Music generation is running…':'No audio generated yet.'}</div>`}</div>
          <div class='song-actions'></div></div>`;
        const actions=row.querySelector('.song-actions');
        if(song.status==='ready'){
          const pub=document.createElement('button'); pub.className='btn btn-primary'; pub.textContent='Publish'; pub.addEventListener('click',async()=>{pub.disabled=true;try{await publishSong(song);}catch(err){showToast(err.message||'Could not publish');pub.disabled=false;}}); actions.appendChild(pub);
          const regen=document.createElement('button'); regen.className='btn'; regen.textContent='Regenerate'; regen.addEventListener('click',async()=>{regen.disabled=true;try{await retrySongGeneration(song);}catch(err){showToast(err.message||'Could not regenerate');regen.disabled=false;}}); actions.appendChild(regen);
        }else if(song.status==='published'){
          const mark=document.createElement('span'); mark.className='small'; mark.textContent='Live on StreamNest'; actions.appendChild(mark);
        }else if(song.status!=='generating'){
          const retry=document.createElement('button'); retry.className='btn btn-primary'; retry.textContent=latestJob&&latestJob.status==='queued'?'Generate now':'Retry generation'; retry.addEventListener('click',async()=>{retry.disabled=true;retry.textContent='Generating…';try{await retrySongGeneration(song);}catch(err){showToast(err.message||'Could not generate song');retry.disabled=false;retry.textContent='Try again';}}); actions.appendChild(retry);
        }
        const audio=row.querySelector('audio.music-player');
        if(audio) resolveSongAudio(song,audio);
        list.appendChild(row);
      });
      section.appendChild(list); host.appendChild(section);
    }).catch(err=>{host.innerHTML=`<div class='provider-note'>Could not load artists: ${escapeHtml(err.message||String(err))}</div>`;});
  }


  // Seed creators and videos if empty
  if(state.creators.length < 8) seedCreators();
  if(state.videos.length < 18) seedVideos();
  saveState();

  // Simple router using data-route attributes
  const app = document.getElementById('app');
  const view = document.getElementById('view');
  const splash = document.getElementById('splash');
  const enterBtn = document.getElementById('enter-btn');
  const accountBtn = document.getElementById('account-btn');
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menu-toggle');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const recentSearchesEl = document.getElementById('recent-searches');
  const searchBtn = document.getElementById('search-btn');
  const voiceBtn = document.getElementById('voice-btn');
  const uploadBtn = document.getElementById('upload-btn');
  const createBtn = document.getElementById('create-btn');
  const notifBtn = document.getElementById('notif-btn');
  const notifCount = document.getElementById('notif-count');
  const profileBtn = document.getElementById('profile-btn');
  const overlay = document.getElementById('overlay');
  const panel = document.getElementById('panel');
  const categoryBar = document.getElementById('category-bar');
  const rightpanel = document.getElementById('rightpanel');

  // UI utilities
  function setRoute(route, params){
    document.body.setAttribute('data-route', route);
    renderRoute(route, params);
    saveState();
  }

  function showOverlay(){overlay.hidden=false;overlay.style.display='block'}
  function hideOverlay(){overlay.hidden=true;overlay.style.display='none';}

  function showPanel(contentHtml){panel.innerHTML=contentHtml;panel.hidden=false;showOverlay();}
  function hidePanel(){panel.hidden=true;hideOverlay();}

  overlay.addEventListener('click', ()=>{hidePanel();hideRightPanel();});

  // Toast
  let toastTimer=null;
  function showToast(msg, time=3500){
    clearTimeout(toastTimer);
    let t = document.getElementById('sn-toast');
    if(!t){t = document.createElement('div');t.id='sn-toast';t.className='panel';t.style.left='50%';t.style.transform='translateX(-50%)';t.style.bottom='80px';t.style.width='auto';document.body.appendChild(t)}
    t.textContent=msg; t.hidden=false;
    toastTimer = setTimeout(()=>{t.hidden=true},time);
  }

  // Bind UI events
  enterBtn.addEventListener('click', ()=>{transitionToHome();});
  if(accountBtn) accountBtn.addEventListener('click', ()=>{setRoute(cloud.user ? 'profile' : 'auth');});
  menuToggle.addEventListener('click', ()=>{sidebar.classList.toggle('open');sidebar.style.display = sidebar.style.display === 'block' ? 'none':'block';});
  sidebarToggle.addEventListener('click', ()=>{state.sidebarCollapsed = !state.sidebarCollapsed; saveState(); renderSidebar();});
  searchForm.addEventListener('submit', (e)=>{e.preventDefault();doSearch(searchInput.value.trim());});
  voiceBtn.addEventListener('click', ()=>{const v=prompt('Voice search (type your query):'); if(v) {searchInput.value=v; doSearch(v);} });
  searchInput.addEventListener('input', debounce(showRecentSearches, 250));
  uploadBtn.addEventListener('click', ()=>{setRoute('upload');});
  createBtn.addEventListener('click', ()=>{setRoute('upload');});
  notifBtn.addEventListener('click', ()=>{setRoute('notifications');});
  profileBtn.addEventListener('click', ()=>{setRoute('profile');});

  // Bottom nav + sidebar nav
  document.querySelectorAll('[data-route]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{ const r = btn.getAttribute('data-route'); setRoute(r); });
  });
  document.querySelectorAll('.side-link').forEach(btn=>{btn.addEventListener('click', ()=>setRoute(btn.getAttribute('data-route')));});

  // Keyboard shortcuts for player later (delegated when player active)
  document.addEventListener('keydown', (e)=>{
    const route = document.body.getAttribute('data-route');
    if(route==='watch'){
      const player = document.querySelector('.video-el');
      if(!player) return;
      if(e.key===' ' || e.key.toLowerCase()==='k'){ e.preventDefault(); togglePlay(player);} 
      if(e.key.toLowerCase()==='j'){ seekBy(player, -10);}
      if(e.key.toLowerCase()==='l'){ seekBy(player, 10);}
      if(e.key.toLowerCase()==='m'){ player.muted = !player.muted; }
      if(e.key.toLowerCase()==='f'){ toggleFullscreen(player);} 
      if(e.key==='ArrowLeft'){ seekBy(player, -5);} if(e.key==='ArrowRight'){ seekBy(player, 5);} if(e.key==='ArrowUp'){ changeVolume(player, 0.05);} if(e.key==='ArrowDown'){ changeVolume(player, -0.05);} 
    }
  });

  // Render sidebar
  function renderSidebar(){
    if(state.sidebarCollapsed){sidebar.classList.add('collapsed');sidebar.style.width='64px';sidebar.querySelectorAll('button').forEach(b=>{b.title=b.textContent; b.textContent=b.textContent.slice(0,2)});} else{sidebar.classList.remove('collapsed');sidebar.style.width='220px';// restore labels
      // re-render by restoring page
      const labels = ['🏠 Home','🌐 Explore','⭐ Subscriptions','📚 Library','🕒 History','⏱ Watch Later','👍 Liked','🎞 Playlists','🎛 Creator Studio','✨ AI Artists','⚙ Settings','❓ Help'];
      const buttons = sidebar.querySelectorAll('nav ul li button'); buttons.forEach((b,i)=>{b.textContent = labels[i]});
    }
  }
  renderSidebar();

  // Render categories
  const CATEGORIES = ['All','Gaming','Music','Technology','Education','Travel','Food','Sports','Comedy','News','Film','Art','Science'];
  function renderCategories(){
    categoryBar.innerHTML='';
    CATEGORIES.forEach(c=>{
      const chip = document.createElement('button'); chip.className='chip'; chip.textContent=c; chip.addEventListener('click', ()=>{setRoute('home',{category:c});}); categoryBar.appendChild(chip);
    });
  }
  renderCategories();

  // Router rendering
  function renderRoute(route, params){
    // hide splash
    splash.style.display='none';
    // Clear view
    view.innerHTML = '';
    if(route==='home'){renderHome(params);} else if(route==='auth'){renderAuth();} else if(route==='ai-artists'){renderAiArtists();} else if(route==='explore'){renderExplore();} else if(route==='shorts'){renderShorts();} else if(route==='search'){renderSearch(params);} else if(route==='watch'){renderWatch(params);} else if(route==='channel'){renderChannel(params);} else if(route==='upload'){renderUpload(params);} else if(route==='creator-studio'){renderStudio();} else if(route==='subscriptions'){renderSubscriptions();} else if(route==='library'){renderLibrary();} else if(route==='history'){renderHistory();} else if(route==='watchlater'){renderWatchLater();} else if(route==='liked'){renderLiked();} else if(route==='playlists'){renderPlaylists();} else if(route==='notifications'){renderNotifications();} else if(route==='profile'){renderProfile();} else if(route==='settings'){renderSettings();} else if(route==='help'){renderHelp();} else {renderHome();}
  }

  // Generate seed creators
  function seedCreators(){
    const names = [{name:'NovaByte', handle:'@novabyte', color:'#FF6B5A'},{name:'Ember Trails',handle:'@ember',color:'#FF8E6B'},{name:'Pixel Forge',handle:'@pixforge',color:'#00E1D6'},{name:'Echo Kitchen',handle:'@echokitchen',color:'#7AD6FF'},{name:'Atlas Classroom',handle:'@atlas',color:'#FFD36B'},{name:'Rhythm Harbor',handle:'@rhythm',color:'#D98CFF'},{name:'BrightSide Sports',handle:'@brightside',color:'#6BFFB3'},{name:'FrameCraft Studio',handle:'@framecraft',color:'#FF6BD1'}];
    state.creators = names.map((c,i)=>({id:'c'+(100+i),name:c.name,handle:c.handle,avatarColor:c.color,subscribers: Math.floor(1200 + Math.random()*90000),verified: i%2===0,joined:Date.now()-Math.floor(Math.random()*1000*60*60*24*365),views:Math.floor(Math.random()*1000000),description:'Creator channel for '+c.name, banners:{},videos:[]}));
  }

  // Generate simulated videos
  function seedVideos(){
    const sample = [
      'Building a Tiny Game Engine from Scratch','Midnight Train Through the Alps','Five-Minute Street Food Challenge','The Science of Deep Ocean Light','I Designed a City in One Weekend','Synthwave Session from the Rooftop','Beginner Guide to Digital Painting','How Electric Cars Manage Heat','Hidden Hiking Paths Near the Coast','Ten Impossible Basketball Shots','Making Music with Everyday Objects','The History of Early Computers','Quick Keyboard Craft','Nighttime Coding Routine','Camping with Minimal Gear','Why Coffee Tastes Different','Drone Views Over the City','Sketching in 20 Minutes'
    ];
    const cats = ['Technology','Travel','Food','Science','Film','Music','Art','Education','Sports','Comedy'];
    const videos = [];
    for(let i=0;i<18;i++){
      const creator = state.creators[i % state.creators.length];
      const id = 'v'+(200+i);
      const title = sample[i % sample.length];
      const duration = `${Math.floor(1+Math.random()*25)}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}`;
      const views = Math.floor(Math.random()*2000000);
      const uploadDate = Date.now() - Math.floor(Math.random()*1000*60*60*24*30*6);
      const video = {
        id, title, description: title + ' — A demo video for StreamNest. Enjoy a simulated playback experience.',
        creatorId: creator.id, creatorName: creator.name, category: cats[i%cats.length], tags:[title.split(' ')[0].toLowerCase(), 'demo'], duration, views, likes:Math.floor(views*0.07), dislikes:Math.floor(views*0.002), uploadDate, thumbnailStyle:{type:'svg',seed:i}, videoSource:null, comments:[], saved:false, liked:false, disliked:false,watchProgress:0,published:true
      };
      videos.push(video);
      // assign to creator
      creator.videos.push(id);
    }
    state.videos = videos.concat(state.videos || []);
  }

  // Utilities for video cards thumbnails
  function makeThumbSVG(title, seed, category, size={w:400,h:225}){
    const colors = ['#FF6B5A','#FF8E6B','#00E1D6','#7AD6FF','#FFD36B','#D98CFF','#6BFFB3','#FF6BD1'];
    const c = colors[seed % colors.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size.w}' height='${size.h}'>
      <defs><linearGradient id='g' x1='0' x2='1'><stop offset='0' stop-color='${c}' stop-opacity='0.95'/><stop offset='1' stop-color='#111' stop-opacity='0.85'/></linearGradient></defs>
      <rect width='100%' height='100%' rx='12' fill='url(#g)' />
      <g fill='rgba(255,255,255,0.92)'><text x='16' y='42' font-size='20' font-family='sans-serif' font-weight='700'>${escapeHtml(title.slice(0,40))}</text></g>
      <g opacity='0.12'><rect x='14' y='64' width='200' height='20' rx='6' fill='#000'/></g>
      <text x='16' y='210' font-size='12' fill='rgba(255,255,255,0.9)'>${category}</text>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function escapeHtml(s){return s.replace(/[&"'<>]/g,function(c){return {'&':'&amp;','"':'&quot;','\'':'&#39;','<':'&lt;','>':'&gt;'}[c]});}

  // Render home
  function renderHome(params){
    const container = document.createElement('div'); container.className='screen-page';
    // Optionally filter by category
    const category = params && params.category && params.category!=='All' ? params.category : null;
    // Trending row
    container.appendChild(makeRow('Trending', state.videos.slice(0,6), category));
    container.appendChild(makeRow('Recommended', state.videos.slice(6,12), category));
    container.appendChild(makeRow('Continue Watching', state.videos.filter(v=>v.watchProgress>0).slice(0,6), category));
    container.appendChild(makeRow('Newly Uploaded', state.videos.slice(12,18), category));
    view.appendChild(container);
  }

  function makeRow(title, items, categoryFilter){
    const row = document.createElement('section'); row.className='row';
    const h = document.createElement('h2'); h.textContent = title; row.appendChild(h);
    const grid = document.createElement('div'); grid.className='grid';
    const filtered = items.filter(it=>!categoryFilter || it.category===categoryFilter);
    filtered.forEach(v=>{ grid.appendChild(makeCard(v)); });
    row.appendChild(grid);
    return row;
  }

  function makeCard(video){
    const c = document.createElement('article'); c.className='card';
    const thumb = document.createElement('div'); thumb.className='thumb'; thumb.setAttribute('role','button'); thumb.tabIndex=0;
    const img = document.createElement('img'); img.alt = video.title; img.style.width='100%'; img.style.height='100%'; img.style.objectFit='cover'; img.style.borderRadius='8px'; img.src = makeThumbSVG(video.title, parseInt(video.id.replace(/\D/g,'')) || 1, video.category);
    thumb.appendChild(img);
    const dur = document.createElement('div'); dur.className='duration'; dur.textContent = video.duration; thumb.appendChild(dur);
    thumb.addEventListener('click', ()=>{setRoute('watch',{id:video.id});});
    thumb.addEventListener('keypress',(e)=>{if(e.key==='Enter'){setRoute('watch',{id:video.id});}});
    c.appendChild(thumb);
    const meta = document.createElement('div'); meta.className='meta';
    const av = document.createElement('div'); av.className='creator-avatar'; av.textContent = video.creatorName.split(' ').map(s=>s[0]).slice(0,2).join('');
    meta.appendChild(av);
    const t = document.createElement('div'); t.style.flex='1';
    const h3 = document.createElement('h3'); h3.textContent = video.title; t.appendChild(h3);
    const p = document.createElement('p'); p.className='small'; p.textContent = `${video.creatorName} • ${formatViews(video.views)} • ${timeAgo(video.uploadDate)}`; t.appendChild(p);
    meta.appendChild(t);
    c.appendChild(meta);
    return c;
  }

  function formatViews(n){if(n>1000000) return (n/1000000).toFixed(1)+'M views'; if(n>1000) return (n/1000).toFixed(1)+'K views'; return n+' views';}
  function timeAgo(ts){const diff=Date.now()-ts; const d=Math.floor(diff/86400000); if(d<1) return 'today'; if(d<7) return d+'d ago'; if(d<30) return Math.floor(d/7)+'w ago'; return Math.floor(d/30)+'mo ago';}

  // Search
  function showRecentSearches(){
    const q = searchInput.value.trim(); if(!q){recentSearchesEl.hidden=true;return}
    recentSearchesEl.hidden=false; recentSearchesEl.innerHTML='';
    const recs = state.searches.slice(-6).reverse().filter(s=>s.includes(q));
    if(recs.length===0) recentSearchesEl.textContent='No recent searches';
    recs.forEach(s=>{ const b = document.createElement('button'); b.className='chip'; b.textContent=s; b.addEventListener('click', ()=>{searchInput.value=s; doSearch(s);}); recentSearchesEl.appendChild(b);});
    const clr = document.createElement('button'); clr.className='chip'; clr.textContent='Clear recent'; clr.addEventListener('click', ()=>{state.searches=[];saveState(); recentSearchesEl.hidden=true;}); recentSearchesEl.appendChild(clr);
  }

  function doSearch(q){
    if(!q) return;
    state.searches = Array.from(new Set([...state.searches,...[q]])).slice(-20);
    saveState(); setRoute('search',{q});
  }

  function renderSearch(params){
    const q = params && params.q ? params.q : '';
    const container = document.createElement('div'); container.className='screen-page';
    const h = document.createElement('h2'); h.textContent = `Search results for "${q}"`; container.appendChild(h);
    const results = searchVideos(q);
    if(results.length===0){ const note = document.createElement('p'); note.textContent='No results found.'; container.appendChild(note);} else{
      const grid = document.createElement('div'); grid.className='grid'; results.forEach(v=>grid.appendChild(makeCard(v))); container.appendChild(grid);
    }
    view.appendChild(container);
  }

  function searchVideos(q){
    if(!q) return [];
    const s = q.toLowerCase();
    return state.videos.filter(v=>{
      return v.title.toLowerCase().includes(s) || v.creatorName.toLowerCase().includes(s) || v.description.toLowerCase().includes(s) || v.category.toLowerCase().includes(s) || (v.tags && v.tags.join(' ').toLowerCase().includes(s));
    });
  }

  // Watch page
  function renderWatch(params){
    const id = params && params.id; const video = state.videos.find(v=>v.id===id);
    const container = document.createElement('div'); container.className='screen-page';
    if(!video){ container.appendChild(makeNotFound('Video not found')); view.appendChild(container); return; }

    // Player area
    const playerWrap = document.createElement('div'); playerWrap.className='video-player'; playerWrap.style.marginBottom='12px';

    let mediaEl;
    if(video.videoSource && video.videoSource.objectUrl){
      mediaEl = document.createElement('video'); mediaEl.className='video-el'; mediaEl.controls=true; mediaEl.src = video.videoSource.objectUrl; mediaEl.width=960; mediaEl.height=540; mediaEl.preload='metadata';
      mediaEl.addEventListener('timeupdate', ()=>{ video.watchProgress = mediaEl.currentTime / (mediaEl.duration || 1); updateHistory(video, mediaEl.currentTime); saveState(); });
      mediaEl.addEventListener('ended', ()=>{ video.watchProgress = 1; pushNextInQueue(video); saveState(); });
    } else {
      // simulated video — use canvas-based player
      mediaEl = makeSimulatedPlayer(video);
    }
    playerWrap.appendChild(mediaEl);

    // Simple controls row
    const controls = document.createElement('div'); controls.className='player-controls';
    const playBtn = document.createElement('button'); playBtn.textContent='Play'; playBtn.className='icon-btn'; playBtn.addEventListener('click', ()=>togglePlay(mediaEl));
    controls.appendChild(playBtn);
    const seek = document.createElement('input'); seek.type='range'; seek.min=0; seek.max=1000; seek.value=0; seek.className='range'; seek.addEventListener('input', ()=>{ if(mediaEl.duration){ mediaEl.currentTime = (seek.value/1000)*mediaEl.duration; }});
    mediaEl.addEventListener('timeupdate', ()=>{ if(mediaEl.duration) seek.value = Math.round((mediaEl.currentTime/mediaEl.duration)*1000);});
    controls.appendChild(seek);
    const time = document.createElement('div'); time.className='small'; time.textContent='0:00 / '+video.duration; controls.appendChild(time);
    playerWrap.appendChild(controls);

    container.appendChild(playerWrap);

    // Info and actions
    const info = document.createElement('div'); info.className='kv';
    const left = document.createElement('div'); left.style.flex='1';
    const title = document.createElement('h2'); title.textContent = video.title; left.appendChild(title);
    const meta = document.createElement('div'); meta.className='small'; meta.textContent = `${formatViews(video.views)} • ${timeAgo(video.uploadDate)}`; left.appendChild(meta);
    info.appendChild(left);

    const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
    const likeBtn = document.createElement('button'); likeBtn.className='icon-btn'; likeBtn.textContent='👍 '+video.likes; likeBtn.addEventListener('click', ()=>{ toggleLike(video, likeBtn, dislikeBtn); });
    const dislikeBtn = document.createElement('button'); dislikeBtn.className='icon-btn'; dislikeBtn.textContent='👎 '+video.dislikes; dislikeBtn.addEventListener('click', ()=>{ toggleDislike(video, likeBtn, dislikeBtn); });
    const saveBtn = document.createElement('button'); saveBtn.className='icon-btn'; saveBtn.textContent = video.saved ? 'Saved' : 'Save'; saveBtn.addEventListener('click', ()=>{ video.saved = !video.saved; saveBtn.textContent = video.saved ? 'Saved':'Save'; saveState(); showToast(video.saved?'Saved to your library':'Removed from saved'); });
    const shareBtn = document.createElement('button'); shareBtn.className='icon-btn'; shareBtn.textContent='Share'; shareBtn.addEventListener('click', ()=>openSharePanel(video));
    actions.appendChild(likeBtn); actions.appendChild(dislikeBtn); actions.appendChild(saveBtn); actions.appendChild(shareBtn);
    info.appendChild(actions);
    container.appendChild(info);

    // Creator block
    const creator = state.creators.find(c=>c.id===video.creatorId) || {name:video.creatorName,subscribers:0};
    const creatorRow = document.createElement('div'); creatorRow.style.display='flex'; creatorRow.style.alignItems='center'; creatorRow.style.gap='12px'; creatorRow.style.marginTop='12px';
    const avatar = document.createElement('div'); avatar.className='creator-avatar'; avatar.textContent = creator.name.split(' ').map(s=>s[0]).slice(0,2).join(''); creatorRow.appendChild(avatar);
    const cinfo = document.createElement('div'); cinfo.style.flex='1'; cinfo.innerHTML = `<div style='font-weight:700'>${creator.name}${creator.verified? ' <span class="small">✔</span>':''}</div><div class='small'>${formatViews(creator.views || 0)} • ${formatSubs(creator.subscribers)}</div>`;
    creatorRow.appendChild(cinfo);
    const subBtn = document.createElement('button'); subBtn.className='btn'; subBtn.textContent = state.subscriptions.includes(creator.id) ? 'Subscribed' : 'Subscribe'; subBtn.addEventListener('click', ()=>{ toggleSubscribe(creator, subBtn); });
    creatorRow.appendChild(subBtn);
    container.appendChild(creatorRow);

    // Description and comments
    const desc = document.createElement('details'); desc.innerHTML = `<summary class='small'>Description</summary><div class='small' style='padding:8px 0'>${video.description}</div>`;
    container.appendChild(desc);

    // Comments
    container.appendChild(renderCommentsSection(video));

    // Recommendations
    renderUpNextList(video);

    view.appendChild(container);
  }

  function makeNotFound(msg){ const el = document.createElement('div'); el.textContent=msg; return el; }

  function formatSubs(n){if(n>1000000) return (n/1000000).toFixed(1)+'M subscribers'; if(n>1000) return (n/1000).toFixed(1)+'K subscribers'; return n+' subscribers';}

  function toggleLike(video, likeBtn, dislikeBtn){ if(video.liked){ video.liked=false; video.likes=Math.max(0, video.likes-1);} else{ video.liked=true; video.likes+=1; if(video.disliked){ video.disliked=false; video.dislikes=Math.max(0,video.dislikes-1);} } saveState(); likeBtn.textContent='👍 '+video.likes; dislikeBtn.textContent='👎 '+video.dislikes; }
  function toggleDislike(video, likeBtn, dislikeBtn){ if(video.disliked){ video.disliked=false; video.dislikes=Math.max(0, video.dislikes-1);} else{ video.disliked=true; video.dislikes+=1; if(video.liked){ video.liked=false; video.likes=Math.max(0,video.likes-1);} } saveState(); likeBtn.textContent='👍 '+video.likes; dislikeBtn.textContent='👎 '+video.dislikes; }

  function toggleSubscribe(creator, btn){ const idx = state.subscriptions.indexOf(creator.id); if(idx===-1){ state.subscriptions.push(creator.id); btn.textContent='Subscribed'; pushNotification({type:'subscribe',text:`You subscribed to ${creator.name}`}); } else { state.subscriptions.splice(idx,1); btn.textContent='Subscribe'; } saveState(); }

  function openSharePanel(video){ const html = `<h3>Share "${escapeHtml(video.title)}"</h3>
    <div class='small'>Link</div><input class='input' value='streamnest://video/${video.id}' readonly onfocus='this.select()'>
    <label><input type='checkbox' id='start-at'/> Start at current time</label>
    <div style='margin-top:8px'><button id='copy-ok' class='btn'>Close</button></div>`;
    showPanel(html);
    document.getElementById('copy-ok').addEventListener('click', hidePanel);
  }

  // Comments system
  function renderCommentsSection(video){
    const wrap = document.createElement('div'); wrap.style.marginTop='18px';
    const h = document.createElement('h3'); h.textContent='Comments'; wrap.appendChild(h);
    const form = document.createElement('div'); form.className='form-row';
    const input = document.createElement('textarea'); input.placeholder='Add a public comment...'; form.appendChild(input);
    const btn = document.createElement('button'); btn.className='btn btn-primary'; btn.textContent='Comment'; btn.addEventListener('click', ()=>{ const text = input.value.trim(); if(!text) return; addComment(video.id, {id:'c'+Date.now(),user:state.profile.username,text,likes:0,replies:[],ts:Date.now()}); input.value=''; renderComments(video, list); });
    form.appendChild(btn); wrap.appendChild(form);
    const list = document.createElement('div'); list.id = 'comments-'+video.id; list.style.marginTop='8px'; wrap.appendChild(list);
    renderComments(video, list);
    return wrap;
  }

  function renderComments(video, container){
    const comments = state.comments[video.id] || (state.comments[video.id]=[]);
    container.innerHTML='';
    const sort = 'newest';
    const arr = comments.slice().sort((a,b)=> sort==='newest' ? b.ts - a.ts : (b.likes - a.likes));
    arr.forEach(c=>{
      const el = document.createElement('div'); el.className='comment';
      el.innerHTML = `<div style='display:flex;gap:10px'><div class='creator-avatar' style='width:40px;height:40px;font-size:14px'>${(c.user||'U').split(' ').map(s=>s[0]).slice(0,2).join('')}</div><div style='flex:1'><div style='font-weight:700'>${c.user} <span class='small'>• ${timeAgo(c.ts)}</span></div><div style='margin-top:6px'>${escapeHtml(c.text)}</div><div class='small' style='margin-top:6px'>Likes: ${c.likes} • <button class='reply-btn'>Reply</button> <button class='delete-btn'>Delete</button></div></div></div>`;
      const replyBtn = el.querySelector('.reply-btn'); replyBtn.addEventListener('click', ()=>{const r = prompt('Reply:'); if(r) { c.replies = c.replies||[]; c.replies.push({user:state.profile.username,text:r,ts:Date.now()}); saveState(); renderComments(video,container);} });
      const delBtn = el.querySelector('.delete-btn'); delBtn.addEventListener('click', ()=>{ if(confirm('Delete comment?')){ state.comments[video.id]=state.comments[video.id].filter(x=>x.id!==c.id); saveState(); renderComments(video,container); } });
      // show replies
      if(c.replies && c.replies.length){ const rwrap = document.createElement('div'); rwrap.style.marginTop='8px'; c.replies.forEach(r=>{ const re = document.createElement('div'); re.className='comment'; re.style.marginLeft='40px'; re.innerHTML=`<div style='font-weight:700'>${r.user} <span class='small'>• ${timeAgo(r.ts)}</span></div><div>${escapeHtml(r.text)}</div>`; rwrap.appendChild(re); }); el.appendChild(rwrap); }
      container.appendChild(el);
    });
  }

  function addComment(videoId, comment){ state.comments[videoId] = state.comments[videoId]||[]; state.comments[videoId].push(comment); pushNotification({type:'comment',text:`New comment on your video`}); saveState(); }

  // Player helpers
  function togglePlay(el){ if(el.paused!==undefined){ if(el.paused) el.play(); else el.pause(); } else if(el.toggle){ el.toggle(); } }
  function seekBy(el, secs){ try{ if(el.currentTime!==undefined) el.currentTime = Math.max(0, Math.min((el.duration||0), el.currentTime + secs)); }catch(e){} }
  function changeVolume(el, delta){ try{ el.volume = Math.max(0, Math.min(1, (el.volume||1) + delta)); }catch(e){} }
  function toggleFullscreen(el){ try{ if(document.fullscreenElement) document.exitFullscreen(); else if(el.requestFullscreen) el.requestFullscreen(); }catch(e){} }

  // Simulated player using canvas
  function makeSimulatedPlayer(video){
    const container = document.createElement('div'); container.style.background='#000'; container.style.position='relative'; container.style.height='360px'; container.style.borderRadius='12px';
    const canvas = document.createElement('canvas'); canvas.width=960; canvas.height=540; canvas.className='video-el'; canvas.style.width='100%'; canvas.style.height='100%'; canvas.style.display='block';
    container.appendChild(canvas);
    let playing=false; let t0=0, pos= (video.watchProgress||0)*60; // seconds
    const ctx = canvas.getContext('2d');
    let rafId=null;
    function draw(now){ ctx.clearRect(0,0,canvas.width,canvas.height); // background
      // animated gradient
      const g = ctx.createLinearGradient(0,0,canvas.width,canvas.height); g.addColorStop(0,'#111'); g.addColorStop(1,'#222'); ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);
      // moving shapes
      const x = (now/1000) % canvas.width; ctx.fillStyle='rgba(255,107,90,0.12)'; ctx.beginPath(); ctx.ellipse((x%canvas.width),canvas.height/2,180,80,0,0,Math.PI*2); ctx.fill();
      // title overlay
      ctx.fillStyle='rgba(255,255,255,0.92)'; ctx.font='28px sans-serif'; ctx.fillText(video.title.slice(0,40),20,50);
      // time indicator
      const duration = (parseInt(video.duration.split(':')[0]) || 2) * 60 + parseInt(video.duration.split(':')[1]||0);
      const cur = Math.floor(pos%duration);
      ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='16px monospace'; ctx.fillText(formatTime(cur)+' / '+video.duration,20,canvas.height-20);
      if(playing){ pos += (1/60); }
      rafId = requestAnimationFrame(draw);
    }
    function play(){ if(!playing){ playing=true; t0=performance.now(); rafId = requestAnimationFrame(draw);} }
    function pause(){ playing=false; if(rafId) cancelAnimationFrame(rafId); saveProgress(); }
    function saveProgress(){ video.watchProgress = Math.min(1, (pos/((parseInt(video.duration.split(':')[0])*60)+parseInt(video.duration.split(':')[1]||0)))); updateHistory(video, Math.floor(pos)); saveState(); }
    canvas.addEventListener('click', ()=>{ playing = !playing; if(playing) play(); else pause(); });
    // expose minimal interface: currentTime,duration,paused,play,pause
    const api = Object.create(null);
    api.play = ()=>{ if(!playing) play(); };
    api.pause = ()=>{ if(playing) pause(); };
    api.toggle = ()=>{ if(playing) pause(); else play(); };
    api.addEventListener = (ev,fn)=>{ /* no-op for now */ };
    api.removeEventListener = ()=>{};
    Object.defineProperty(api,'paused',{get:()=>!playing});
    Object.defineProperty(api,'currentTime',{get:()=>pos, set(v){ pos=v; }});
    Object.defineProperty(api,'duration',{get:()=>((parseInt(video.duration.split(':')[0])||2)*60 + parseInt(video.duration.split(':')[1]||0))});
    // start paused
    draw(performance.now());
    return api;
  }
  function formatTime(secs){ const m=Math.floor(secs/60); const s=Math.floor(secs%60); return m+':'+String(s).padStart(2,'0'); }

  // History
  function updateHistory(video, time){ const entry = state.history.find(h=>h.id===video.id); const now=Date.now(); if(entry){ entry.lastWatched=now; entry.progress = video.watchProgress; } else { state.history.unshift({id:video.id,title:video.title,lastWatched:now,progress:video.watchProgress||0}); if(state.history.length>200) state.history.pop(); } saveState(); }

  // Up next list
  function renderUpNextList(current){ rightpanel.hidden=false; const up = document.getElementById('upnext-list'); if(!up) return; up.innerHTML=''; const others = state.videos.filter(v=>v.id!==current.id).slice(0,6); others.forEach(v=>{ const e = document.createElement('div'); e.className='card'; e.style.marginBottom='8px'; e.innerHTML = `<div style='display:flex;gap:8px'><img src='${makeThumbSVG(v.title,parseInt(v.id.replace(/\D/g,'')))}' style='width:100px;height:56px;object-fit:cover;border-radius:6px' /><div style='flex:1'><div style='font-weight:700'>${v.title}</div><div class='small'>${v.creatorName} • ${formatViews(v.views)}</div></div></div>`; e.addEventListener('click', ()=>setRoute('watch',{id:v.id})); up.appendChild(e); }); }
  function hideRightPanel(){ rightpanel.hidden=true; }
  function renderUpNextList(video){ const up = document.getElementById('upnext-list'); if(!up) return; up.innerHTML=''; const arr = state.videos.filter(v=>v.id!==video.id).slice(0,6); arr.forEach(v=>{ const row = document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.marginBottom='8px'; const img = document.createElement('img'); img.src = makeThumbSVG(v.title, parseInt(v.id.replace(/\D/g,''))); img.style.width='120px'; img.style.height='68px'; img.style.objectFit='cover'; img.style.borderRadius='8px'; row.appendChild(img); const txt = document.createElement('div'); txt.style.flex='1'; txt.innerHTML = `<div style='font-weight:700'>${v.title}</div><div class='small'>${v.creatorName} • ${formatViews(v.views)}</div>`; row.appendChild(txt); txt.addEventListener('click', ()=>setRoute('watch',{id:v.id})); up.appendChild(row); }); }

  function pushNextInQueue(video){ const idx = state.videos.findIndex(v=>v.id===video.id); const next = state.videos[idx+1]; if(next && state.settings.autoplay){ setRoute('watch',{id:next.id}); }
  }

  // Subscriptions page
  function renderSubscriptions(){ const c = document.createElement('div'); c.className='screen-page'; const h = document.createElement('h2'); h.textContent='Subscriptions'; c.appendChild(h);
    const subs = state.subscriptions.map(id=>state.creators.find(cr=>cr.id===id)).filter(Boolean);
    if(subs.length===0){ const p = document.createElement('p'); p.textContent='You are not subscribed to any channels yet.'; c.appendChild(p);} else{
      subs.forEach(ch=>{ const el = document.createElement('div'); el.className='card'; el.style.display='flex'; el.style.alignItems='center'; el.style.justifyContent='space-between'; el.innerHTML = `<div style='display:flex;gap:10px;align-items:center'><div class='creator-avatar' style='width:48px;height:48px'>${ch.name.split(' ').map(s=>s[0]).slice(0,2).join('')}</div><div><div style='font-weight:700'>${ch.name}</div><div class='small'>${formatSubs(ch.subscribers)}</div></div></div>`; const b = document.createElement('button'); b.className='btn'; b.textContent='Manage'; b.addEventListener('click', ()=>{ showPanel(`<h3>${ch.name}</h3><div class='small'>Notifications: <label><input type='checkbox' ${Math.random()>0.5?'checked':''}/> All</label></div><div style='margin-top:8px'><button class='btn'>Close</button></div>`); panel.querySelector('button').addEventListener('click', hidePanel); }); el.appendChild(b); c.appendChild(el); });
    }
    view.appendChild(c);
  }

  // Upload flow
  function renderUpload(){
    const c = document.createElement('div'); c.className='screen-page'; c.innerHTML = `<h2>Upload Video</h2>`;
    const form = document.createElement('div'); form.className='form-row';
    const fileIn = document.createElement('input'); fileIn.type='file'; fileIn.accept='video/mp4,video/webm,video/ogg'; form.appendChild(fileIn);
    const preview = document.createElement('div'); preview.className='preview-thumb'; preview.textContent='No file selected'; form.appendChild(preview);
    const title = document.createElement('input'); title.className='input'; title.placeholder='Video title'; form.appendChild(title);
    const desc = document.createElement('textarea'); desc.className='input'; desc.placeholder='Description'; form.appendChild(desc);
    const cat = document.createElement('select'); cat.className='input'; CATEGORIES.filter(c=>c!=='All').forEach(x=>{ const o=document.createElement('option'); o.value=x; o.textContent=x; cat.appendChild(o); }); form.appendChild(cat);
    const tags = document.createElement('input'); tags.className='input'; tags.placeholder='Tags (comma separated)'; form.appendChild(tags);
    const thumbBtn = document.createElement('button'); thumbBtn.className='btn'; thumbBtn.textContent='Generate Thumbnail'; form.appendChild(thumbBtn);
    const publishBtn = document.createElement('button'); publishBtn.className='btn btn-primary'; publishBtn.textContent='Publish'; form.appendChild(publishBtn);
    c.appendChild(form);
    view.appendChild(c);

    let fileUrl = null; let fileObj=null; let thumbData=null;
    fileIn.addEventListener('change', ()=>{
      const f = fileIn.files[0]; if(!f) return; if(!['video/mp4','video/webm','video/ogg'].includes(f.type)){ alert('Unsupported file type'); return; }
      fileObj = f; if(fileUrl) URL.revokeObjectURL(fileUrl); fileUrl = URL.createObjectURL(f); preview.innerHTML=''; const v = document.createElement('video'); v.controls=true; v.src=fileUrl; v.style.maxWidth='100%'; v.style.maxHeight='160px'; preview.appendChild(v);
    });

    thumbBtn.addEventListener('click', ()=>{
      // generate thumbnail from title/colors
      thumbData = makeThumbSVG(title.value || 'Untitled', Math.floor(Math.random()*10), cat.value, {w:640,h:360});
      preview.innerHTML = `<img src='${thumbData}' style='width:100%;height:160px;object-fit:cover;border-radius:8px'>`;
    });

    publishBtn.addEventListener('click', ()=>{
      if(!fileObj){ alert('Please choose a video file to upload.'); return; }
      if(!title.value.trim()){ alert('Please enter a title.'); return; }
      // Simulate upload progress
      const vidId = 'v'+(Date.now());
      const meta = {id:vidId,title:title.value,description:desc.value,creatorId:state.creators[0].id,creatorName:state.creators[0].name,category:cat.value,tags:tags.value.split(',').map(s=>s.trim()).filter(Boolean),duration:'0:00',views:0,likes:0,dislikes:0,uploadDate:Date.now(),thumbnailStyle:{type:'data',data:thumbData},videoSource:{objectUrl:URL.createObjectURL(fileObj)},comments:[],saved:false,liked:false,disliked:false,watchProgress:0,published:true};
      state.videos.unshift(meta); state.uploads.push(meta.id); state.creators[0].videos.push(meta.id); saveState(); showToast('Upload complete — video published'); setRoute('watch',{id:meta.id});
    });
  }

  // Channel page
  function renderChannel(params){ const id = params.id; const ch = state.creators.find(c=>c.id===id); const wrap=document.createElement('div'); wrap.className='screen-page'; if(!ch){ wrap.appendChild(makeNotFound('Channel not found')); view.appendChild(wrap); return;} wrap.innerHTML=`<div style='display:flex;gap:12px;align-items:center'><div class='preview-thumb' style='width:120px;height:120px;border-radius:12px'>${ch.name.split(' ').map(s=>s[0]).slice(0,2).join('')}</div><div><h2>${ch.name} ${ch.verified?'<span class="small">✔</span>':''}</h2><div class='small'>${formatSubs(ch.subscribers)} • Joined ${timeAgo(ch.joined)}</div><div style='margin-top:8px' class='small'>${escapeHtml(ch.description)}</div></div></div>`;
    const tab = document.createElement('div'); tab.style.marginTop='12px'; tab.innerHTML=`<button class='btn' data-view='home'>Home</button> <button class='btn' data-view='videos'>Videos</button> <button class='btn' data-view='about'>About</button>`; wrap.appendChild(tab);
    const content = document.createElement('div'); content.style.marginTop='12px'; wrap.appendChild(content);
    tab.querySelector('[data-view="home"]').addEventListener('click', ()=>{ content.innerHTML=''; content.appendChild(makeRow('Channel uploads', state.videos.filter(v=>v.creatorId===ch.id), null)); });
    tab.querySelector('[data-view="videos"]').addEventListener('click', ()=>{ content.innerHTML=''; const grid = document.createElement('div'); grid.className='grid'; state.videos.filter(v=>v.creatorId===ch.id).forEach(v=>grid.appendChild(makeCard(v))); content.appendChild(grid); });
    tab.querySelector('[data-view="about"]').addEventListener('click', ()=>{ content.innerHTML=`<div class='card small'>${escapeHtml(ch.description)}</div>`; });
    view.appendChild(wrap);
  }

  // Playlists
  function renderPlaylists(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Playlists</h2>'; if(state.playlists.length===0){ const p=document.createElement('p'); p.textContent='No playlists yet. Create one from a video card.'; c.appendChild(p);} else{ state.playlists.forEach(pl=>{ const el=document.createElement('div'); el.className='card'; el.innerHTML=`<div style='display:flex;justify-content:space-between;align-items:center'><div><div style='font-weight:700'>${pl.name}</div><div class='small'>${pl.videos.length} videos</div></div><div><button class='btn'>Open</button></div></div>`; c.appendChild(el); }); } view.appendChild(c); }

  function renderLibrary(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Library</h2>'; const saved = state.videos.filter(v=>v.saved); if(saved.length===0){ c.appendChild(Object.assign(document.createElement('p'),{textContent:'No saved videos.'})); } else{ const grid=document.createElement('div'); grid.className='grid'; saved.forEach(v=>grid.appendChild(makeCard(v))); c.appendChild(grid);} view.appendChild(c); }

  function renderHistory(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>History</h2>'; if(state.history.length===0){ c.appendChild(Object.assign(document.createElement('p'),{textContent:'No watch history.'})); } else{ const list=document.createElement('div'); state.history.forEach(h=>{ const v=state.videos.find(x=>x.id===h.id); const el=document.createElement('div'); el.className='card'; el.style.display='flex'; el.style.justifyContent='space-between'; el.innerHTML=`<div><div style='font-weight:700'>${v?v.title:h.id}</div><div class='small'>Last watched ${timeAgo(h.lastWatched)} • ${(h.progress*100).toFixed(0)}%</div></div><div><button class='btn'>Remove</button></div>`; list.appendChild(el); }); c.appendChild(list);} view.appendChild(c); }

  function renderWatchLater(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Watch Later</h2>'; const list=state.videos.filter(v=>v.saved); if(list.length===0) c.appendChild(Object.assign(document.createElement('p'),{textContent:'No items.'})); else{ const grid=document.createElement('div'); grid.className='grid'; list.forEach(v=>grid.appendChild(makeCard(v))); c.appendChild(grid);} view.appendChild(c); }

  function renderLiked(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Liked Videos</h2>'; const list=state.videos.filter(v=>v.liked); if(list.length===0) c.appendChild(Object.assign(document.createElement('p'),{textContent:'No liked videos.'})); else{ const grid=document.createElement('div'); grid.className='grid'; list.forEach(v=>grid.appendChild(makeCard(v))); c.appendChild(grid);} view.appendChild(c); }

  // Creator studio overview
  function renderStudio(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Creator Studio</h2>'; // dashboard cards
    const totals = {views:state.videos.reduce((s,v)=>s+v.views,0),videos:state.videos.length,subs:state.creators.reduce((s,c)=>s+(c.subscribers||0),0)};
    const cards = document.createElement('div'); cards.style.display='grid'; cards.style.gridTemplateColumns='repeat(auto-fit,minmax(180px,1fr))'; cards.style.gap='10px'; ['Views','Videos','Subscribers'].forEach((k,i)=>{ const card=document.createElement('div'); card.className='card'; card.innerHTML=`<div style='font-size:18px;font-weight:700'>${k}</div><div class='small' style='margin-top:6px'>${k==='Views'?totals.views:(k==='Videos'?totals.videos:totals.subs)}</div>`; cards.appendChild(card); }); c.appendChild(cards);
    // content table
    const table = document.createElement('div'); table.style.marginTop='12px'; table.innerHTML='<h3>Your Content</h3>';
    const grid = document.createElement('div'); grid.className='grid'; state.videos.slice(0,12).forEach(v=>{ const el = document.createElement('div'); el.className='card'; el.innerHTML=`<div style='display:flex;gap:8px'><img src='${makeThumbSVG(v.title,parseInt(v.id.replace(/\D/g,'')))}' style='width:120px;height:68px;object-fit:cover;border-radius:6px'><div style='flex:1'><div style='font-weight:700'>${v.title}</div><div class='small'>${v.views} views • ${timeAgo(v.uploadDate)}</div></div></div>`; grid.appendChild(el); }); table.appendChild(grid); c.appendChild(table);
    view.appendChild(c);
  }

  // Notifications
  function pushNotification(n){ n.id='n'+Date.now(); n.read=false; n.ts=Date.now(); state.notifications.unshift(n); if(state.notifications.length>200) state.notifications.pop(); saveState(); renderNotifCount(); }
  function renderNotifCount(){ const unread = state.notifications.filter(n=>!n.read).length; if(unread>0){ notifCount.hidden=false; notifCount.textContent = unread; } else { notifCount.hidden=true; } }
  function renderNotifications(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Notifications</h2>'; if(state.notifications.length===0) c.appendChild(Object.assign(document.createElement('p'),{textContent:'No notifications.'})); else{ const list=document.createElement('div'); state.notifications.forEach(n=>{ const el=document.createElement('div'); el.className='card'; el.innerHTML=`<div style='display:flex;justify-content:space-between;align-items:center'><div><div style='font-weight:700'>${n.text}</div><div class='small'>${timeAgo(n.ts)}</div></div><div><button class='btn'>Mark</button></div></div>`; el.querySelector('button').addEventListener('click', ()=>{ n.read=true; saveState(); renderNotifications(); renderNotifCount(); }); list.appendChild(el); }); c.appendChild(list);} view.appendChild(c); }
  renderNotifCount();

  // Profile — cloud-backed when signed in, local guest profile otherwise.
  function renderProfile(){
    const c=document.createElement('div'); c.className='screen-page'; view.appendChild(c);
    if(!cloud.user){
      c.innerHTML=`<h2>Profile</h2><div class='card'><h3>Guest profile</h3><p class='small'>You're using the local browser demo. Create an account to sync your identity and AI artists.</p><div class='profile-actions'><button class='btn btn-primary' id='profile-auth'>Create account / Sign in</button></div></div>`;
      c.querySelector('#profile-auth').addEventListener('click',()=>setRoute('auth')); return;
    }
    c.innerHTML=`<h2>Profile</h2>${cloudStatusHtml()}<div id='cloud-profile'><div class='small'>Loading profile…</div></div>`;
    refreshCloudState().then(()=>{
      if(document.body.getAttribute('data-route')!=='profile') return;
      const p=cloud.profile; const host=c.querySelector('#cloud-profile');
      host.innerHTML=`<div class='card'><div style='display:flex;gap:12px;align-items:center'><div class='preview-thumb' style='width:120px;height:120px;border-radius:12px;background:${escapeHtml(p.avatar_color||'#FF6B5A')}'>${escapeHtml(p.username.split(' ').map(x=>x[0]).slice(0,2).join(''))}</div><div><div style='font-weight:700'>${escapeHtml(p.username)}</div><div class='small'>${escapeHtml(p.handle)} • Joined ${timeAgo(new Date(p.joined_at).getTime())}</div><div style='margin-top:8px' class='small'>${escapeHtml(p.bio||'')}</div></div></div></div><div class='profile-actions'><button class='btn btn-primary' id='edit-cloud-profile'>Edit profile</button><button class='btn' id='open-ai-artists'>AI Artists</button><button class='btn' id='profile-signout'>Sign out</button></div>`;
      host.querySelector('#open-ai-artists').addEventListener('click',()=>setRoute('ai-artists'));
      host.querySelector('#profile-signout').addEventListener('click',async()=>{await cloud.client.auth.signOut();showToast('Signed out');setRoute('home');});
      host.querySelector('#edit-cloud-profile').addEventListener('click',async()=>{
        const name=prompt('Display name',p.username); if(!name) return;
        const bio=prompt('Bio',p.bio||''); if(bio===null) return;
        const {data,error}=await cloud.client.from('profiles').update({username:name.trim().slice(0,60),bio:bio.trim().slice(0,500),updated_at:new Date().toISOString()}).eq('id',cloud.user.id).select('*').single();
        if(error){showToast(error.message);return;} cloud.profile=data; syncLocalProfile(); updateAuthUI(); renderRoute('profile');
      });
    }).catch(err=>{c.querySelector('#cloud-profile').innerHTML=`<div class='provider-note'>${escapeHtml(err.message||String(err))}</div>`;});
  }

  // Settings
  function renderSettings(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Settings</h2>'; const form=document.createElement('div'); form.className='form-row'; const dark = document.createElement('label'); dark.innerHTML=`<input type='checkbox' id='s-dark' ${state.settings.darkMode?'checked':''}/> Dark mode`; form.appendChild(dark);
    const auto = document.createElement('label'); auto.innerHTML=`<input type='checkbox' id='s-auto' ${state.settings.autoplay?'checked':''}/> Autoplay`; form.appendChild(auto);
    const rm = document.createElement('label'); rm.innerHTML=`<input type='checkbox' id='s-rm' ${state.settings.reduceMotion?'checked':''}/> Reduce motion`; form.appendChild(rm);
    const exportBtn = document.createElement('button'); exportBtn.className='btn'; exportBtn.textContent='Export data'; exportBtn.addEventListener('click', ()=>{ const data = JSON.stringify(state); const blob = new Blob([data],{type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='streamnest-data.json'; a.click(); URL.revokeObjectURL(url); });
    const importBtn = document.createElement('button'); importBtn.className='btn'; importBtn.textContent='Import data'; importBtn.addEventListener('click', ()=>{ const f = document.createElement('input'); f.type='file'; f.accept='application/json'; f.onchange = ()=>{ const file = f.files[0]; const r = new FileReader(); r.onload = ()=>{ try{ const parsed = JSON.parse(r.result); if(parsed && parsed.version){ state = Object.assign(state, parsed); saveState(); location.reload(); } else alert('Invalid import'); }catch(e){alert('Failed to import: '+e.message);} }; r.readAsText(file); }; f.click(); });
    form.appendChild(exportBtn); form.appendChild(importBtn); c.appendChild(form); view.appendChild(c);
    document.getElementById('s-dark').addEventListener('change',(e)=>{ state.settings.darkMode = e.target.checked; document.body.classList.toggle('sn-dark', state.settings.darkMode); saveState(); });
    document.getElementById('s-auto').addEventListener('change',(e)=>{ state.settings.autoplay = e.target.checked; saveState(); });
    document.getElementById('s-rm').addEventListener('change',(e)=>{ state.settings.reduceMotion = e.target.checked; saveState(); });
  }

  function renderHelp(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Help & About</h2><p class="small">StreamNest now supports Supabase-backed user accounts, persistent profiles and AI artist records. The original video demo data and browser uploads remain local/session-based for now. Music-generation provider integration is the next server-side step.</p>'; view.appendChild(c); }

  // Short videos (simulated vertical)
  function renderShorts(){ const c=document.createElement('div'); c.className='screen-page'; c.innerHTML='<h2>Shorts</h2>'; const list = state.videos.slice(0,6); const container = document.createElement('div'); container.style.display='flex'; container.style.overflow='hidden'; container.style.gap='8px'; list.forEach((v,i)=>{ const el = document.createElement('div'); el.className='card'; el.style.minWidth='100%'; el.style.height='480px'; el.style.display='flex'; el.style.flexDirection='column'; el.innerHTML=`<div style='flex:1;background:#000;border-radius:12px;display:flex;align-items:end;justify-content:space-between;padding:12px'><div style='color:#fff;font-weight:700'>${v.title}</div><div style='color:#fff'>${v.creatorName}</div></div>`; container.appendChild(el); }); c.appendChild(container); const nav = document.createElement('div'); nav.style.display='flex'; nav.style.gap='8px'; nav.style.marginTop='8px'; const prev = document.createElement('button'); prev.className='btn'; prev.textContent='Previous'; const next = document.createElement('button'); next.className='btn'; next.textContent='Next'; let idx=0; function show(i){ container.style.transform = `translateX(-${i*100}%)`; } prev.addEventListener('click', ()=>{ idx = Math.max(0, idx-1); show(idx); }); next.addEventListener('click', ()=>{ idx = Math.min(list.length-1, idx+1); show(idx); }); nav.appendChild(prev); nav.appendChild(next); c.appendChild(nav); view.appendChild(c); }

  // Utilities
  function formatDate(ts){ const d=new Date(ts); return d.toISOString(); }

  // Debounce
  function debounce(fn,wait){ let t; return function(...a){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,a),wait); }; }

  // Start app
  function transitionToHome(){ document.body.setAttribute('data-route','home'); splash.style.display='none'; setRoute('home'); }

  // Initial splash show
  function init(){ document.body.classList.toggle('sn-dark', state.settings.darkMode);
    initCloud();
    // show splash first
    splash.style.display='flex'; document.getElementById('enter-btn').focus();
    // render initial route
    renderNotifCount();
  }
  init();

  // small helpers for corrupted localStorage behavior demonstration
  window._streamnest = {state,cloud,saveState,loadState,refreshCloudState,buildArtistBlueprint};
})();
