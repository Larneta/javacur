(function(){
'use strict';

/* ============================= DATA ============================= */
const COURSES = JSON.parse(document.getElementById('courses-data').textContent);
const CODE_QUESTIONS = JSON.parse(document.getElementById('codeq-data').textContent);

const STOPWORDS = new Set(['a','an','the','of','to','in','on','for','with','its','be','as','into','and','or','is','are','that','this','it','your','you','from','by','at','via','used','use','way','one','way']);
function keywordsFromText(text){
  const words = (text||'').toLowerCase().match(/[a-z][a-z0-9']{2,}/g) || [];
  return [...new Set(words.filter(w=>!STOPWORDS.has(w)))];
}
function keywordsFromCode(code){
  const tokens = (code||'').match(/[A-Za-z_][A-Za-z0-9_]*|@[A-Za-z]+|\*ng[A-Za-z]+/g) || [];
  return [...new Set(tokens.map(t=>t.toLowerCase()))].filter(t=>t.length>1);
}
function checkCoverage(userText, keywords, threshold){
  if(!keywords.length) return {ok:true, hit:0, total:0};
  const lower = (userText||'').toLowerCase();
  const hit = keywords.filter(k=>lower.includes(k)).length;
  return {ok: hit >= Math.ceil(keywords.length*threshold), hit, total: keywords.length};
}
const CHALLENGE_TEMPLATES = {
  'java-core': [
    'Without copying it directly, write your own short bit of Java that demonstrates "{term}" — use different names than the example.',
    'Challenge: rewrite the example above from memory, changing at least one name or value.',
    'Write a tiny new Java example (2-4 lines) that shows "{term}" in action, your own way.'
  ],
  'spring-boot': [
    'Write your own small Spring Boot snippet that demonstrates "{term}" — use a different resource name than the example.',
    'Challenge: rewrite the example above from memory, changing at least one name or path.',
    'Write a short new Spring Boot example that puts "{term}" to use, your own way.'
  ],
  'angular': [
    'Write your own Angular template or TypeScript snippet that demonstrates "{term}" — use different names than the example.',
    'Challenge: rewrite the example above from memory, changing at least one name or value.',
    'Write a short new Angular example that shows "{term}" in action, your own way.'
  ],
  'rest-git': [
    'Write out the command(s) or snippet yourself that demonstrate "{term}" — use a different example than the one above.',
    'Challenge: rewrite the example above from memory, changing at least one detail.',
    'Write a short new example that puts "{term}" to use, your own way.'
  ],
  'default': [
    'Write your own short example that demonstrates "{term}" — use different names than the example above.',
    'Challenge: rewrite the example above from memory, changing at least one detail.',
    'Write a short new example that shows "{term}" in action, your own way.'
  ]
};
function challengeTemplatesFor(courseId){ return CHALLENGE_TEMPLATES[courseId] || CHALLENGE_TEMPLATES['default']; }

const COURSE_ORDER = ['java-core','spring-boot','angular','rest-git'];

/* ============================= STATE ============================= */
let db=null, userCap=null, myId=null, canEdit=false, isOwner=false, dbAvailable=false;
let profile=null;          // {firstName,lastName,dob,email,phone,passwordHash,verified,createdAt,lastActive,stars,completedLessons:[],quizBest:{},practiced:[],coursesCelebrated:[]}
let loggedIn=false;
let pendingOTP=null;       // {code, method, mode:'signup'|'login'}
let pendingSignupData=null;
let authFlowMode='signup'; // 'signup'|'login'|'reset' — controls what happens after OTP verifies
let directoryDocs=[];      // live roster (cloud)
let customCourses=[], customLessons=[], customQuestions=[];
let forumPosts=[];
let ratings=[];
let unsub=[];
let mobileNavOpen=false;
let quizState=null;
let challengeState=null;
let heartbeatTimer=null;

const LS_KEY='javacur_local_profile_v1';

/* ============================= UTIL ============================= */
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg, kind){
  const wrap=document.getElementById('toastWrap');
  const el=document.createElement('div');
  el.className='toast';
  el.textContent=msg;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3600);
}
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function genCode(){ return String(Math.floor(100000+Math.random()*900000)); }
function cloneData(data){ return data ? JSON.parse(JSON.stringify(data)) : data; }
/* Local server build: an account's identity is derived from its email, so the same login works from any browser.
   Call this with the email typed on the signup / login / forgot-password forms before reading that account. */
async function adoptAccount(email){
  if(!userCap || !userCap.idForEmail) return;
  const id = await userCap.idForEmail(email);
  userCap.setId(id);
  myId = id;
  try{ isOwner = await userCap.isOwner(); }catch(e){ isOwner=false; }
  try{ canEdit = await userCap.canEdit(); }catch(e){ canEdit=false; }
  dbAvailable = !!(db && myId);
} // db snapshots are frozen; always clone before treating as mutable state
function fmtDate(ts){ if(!ts) return ''; const d=new Date(ts); return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
function timeAgo(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function allCourses(){
  const built = COURSE_ORDER.map(id=>({id, ...COURSES[id], builtin:true}));
  const custom = customCourses.map(c=>({id:c._id, title:c.title, icon:c.icon||'📘', blurb:c.blurb||'', builtin:false}));
  return built.concat(custom);
}
function lessonsForCourse(courseId){
  const base = COURSES[courseId] ? Object.entries(COURSES[courseId].terms).map(([term,arr])=>({
    key:term, term, definition:arr[0], analogy:arr[1], example:arr[2], tip:arr[3], simple:arr[4]||'', builtin:true
  })) : [];
  const extra = customLessons.filter(l=>l.courseId===courseId).map(l=>({
    key:l._id, term:l.term, definition:l.definition, analogy:l.analogy, example:l.example, tip:l.tip, simple:l.simple||'', builtin:false
  }));
  return base.concat(extra);
}
function courseMeta(courseId){
  if(COURSES[courseId]) return {title:COURSES[courseId].title, icon:COURSES[courseId].icon, blurb:COURSES[courseId].blurb};
  const c = customCourses.find(x=>x._id===courseId);
  return c ? {title:c.title, icon:c.icon||'📘', blurb:c.blurb||''} : {title:courseId, icon:'📘', blurb:''};
}
function courseProgress(courseId){
  const lessons = lessonsForCourse(courseId);
  const done = lessons.filter(l=> (profile?.completedLessons||[]).includes(courseId+'::'+l.key)).length;
  return {done, total:lessons.length, pct: lessons.length? Math.round(done/lessons.length*100):0};
}
function totalProgress(){
  let done=0, total=0;
  allCourses().forEach(c=>{ const p=courseProgress(c.id); done+=p.done; total+=p.total; });
  return {done, total, pct: total? Math.round(done/total*100):0};
}

/* ============================= BOOT ============================= */
async function boot(){
  renderAuthGate({loading:true});
  try{ userCap = await claude.use('user'); }catch(e){ userCap=null; }
  try{ db = await claude.use('db'); }catch(e){ db=null; }
  if(userCap){
    try{ myId = await userCap.id(); }catch(e){ myId=null; }
    try{ canEdit = await userCap.canEdit(); }catch(e){ canEdit=false; }
    try{ isOwner = await userCap.isOwner(); }catch(e){ isOwner=false; }
  }
  dbAvailable = !!(db && myId);

  if(dbAvailable){
    try{
      const snap = await db.doc('data/users/'+myId+'/profile').get();
      profile = snap.exists ? cloneData(snap.data()) : null;
    }catch(e){ profile=null; }
  } else {
    try{ profile = JSON.parse(localStorage.getItem(LS_KEY)||'null'); }catch(e){ profile=null; }
  }
  loggedIn = !!(profile && profile.verified && sessionStorage.getItem('javacur_session')==='1');

  if(dbAvailable){
    watchDirectory();
    watchCustomContent();
    watchForum();
    watchRatings();
    startHeartbeat();
  }
  route();
}

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15*60*1000;

function directoryDefaults(existing){
  // preserve fields that only the owner/admin-management flow should change
  return {
    role: existing ? (existing.role||'student') : (isOwner ? 'owner' : 'student'),
    permissions: existing ? (existing.permissions||{}) : {},
    failedAttempts: existing ? (existing.failedAttempts||0) : 0,
    lockedUntil: existing ? (existing.lockedUntil||null) : null
  };
}

function startHeartbeat(){
  const beat = async ()=>{
    if(!dbAvailable || !myId || !profile) return;
    try{
      const existing = directoryDocs.find(d=>d._id===myId);
      const keep = directoryDefaults(existing);
      await db.doc('directory/'+myId).set({
        firstName: profile.firstName, lastName: profile.lastName, email: profile.email,
        stars: profile.stars||0, completedCount: (profile.completedLessons||[]).length,
        createdAt: profile.createdAt, lastActive: Date.now(), ...keep
      });
    }catch(e){}
  };
  beat();
  if(heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(beat, 20000);
}

const ROLE_LEVELS = {owner:4, superadmin:3, admin:2, student:1};
const ROLE_LABELS = {owner:'👑 Owner', superadmin:'⭐ Super Admin', admin:'🛡️ Admin', student:'Student'};
function myDirRecord(){ return directoryDocs.find(d=>d._id===myId); }
async function freshDirRecord(){ try{ const s=await db.doc('directory/'+myId).get(); return s.exists? s.data() : null; }catch(e){ return myDirRecord()||null; } } // read straight from the server, not the polled cache
function myRole(){ if(isOwner) return 'owner'; const r=myDirRecord(); return r? (r.role||'student') : 'student'; }
function myLevel(){ return ROLE_LEVELS[myRole()]||1; }
function roleLevel(role){ return ROLE_LEVELS[role||'student']||1; }
function canManage(targetRole){ return myLevel() > roleLevel(targetRole); } // strictly outrank the target to act on them
function assignableRoles(){ return ['student','admin','superadmin'].filter(r=>ROLE_LEVELS[r] < myLevel()); }
function isAppAdmin(){
  if(!dbAvailable) return true; // local-only preview mode: no one else to manage, keep full access
  return myLevel() >= ROLE_LEVELS.admin;
}
function hasPerm(name){
  if(!dbAvailable) return true;
  if(isOwner) return true;
  const rec = myDirRecord();
  if(!rec) return false;
  if(rec.role==='superadmin') return true; // super admins hold every granular privilege automatically
  return !!(rec.role==='admin' && rec.permissions && rec.permissions[name]);
}

function watchDirectory(){
  try{
    const u = db.collection('directory').limit(500).onSnapshot(snap=>{
      directoryDocs = snap.docs.map(d=>({_id:d.id, ...d.data()}));
      { const me = directoryDocs.find(d=>d._id===myId); if(me) canEdit = ['owner','superadmin','admin'].includes(me.role||'student'); }
      if(location.hash.includes('admin') || location.hash===''||location.hash==='#/'||location.hash==='#/app') render();
    }, ()=>{});
    unsub.push(u);
  }catch(e){}
}
function watchCustomContent(){
  try{
    unsub.push(db.collection('custom_courses').limit(100).onSnapshot(s=>{ customCourses=s.docs.map(d=>({_id:d.id,...d.data()})); render(); }, ()=>{}));
    unsub.push(db.collection('custom_lessons').limit(300).onSnapshot(s=>{ customLessons=s.docs.map(d=>({_id:d.id,...d.data()})); render(); }, ()=>{}));
    unsub.push(db.collection('custom_questions').limit(300).onSnapshot(s=>{ customQuestions=s.docs.map(d=>({_id:d.id,...d.data()})); }, ()=>{}));
  }catch(e){}
}
function watchForum(){
  try{
    unsub.push(db.collection('forum_posts').orderBy('createdAt','desc').limit(100).onSnapshot(s=>{
      forumPosts = s.docs.map(d=>({_id:d.id,...d.data()}));
      if(location.hash.includes('forum')) render();
    }, ()=>{}));
  }catch(e){}
}
function watchRatings(){
  try{
    unsub.push(db.collection('ratings').limit(500).onSnapshot(s=>{
      ratings = s.docs.map(d=>({_id:d.id,...d.data()}));
      if(location.hash.includes('ratings')||location.hash.includes('admin')) render();
    }, ()=>{}));
  }catch(e){}
}

/* ============================= PERSIST PROFILE ============================= */
async function saveProfile(){
  let profileSaved = true;
  if(dbAvailable){
    try{ await db.doc('data/users/'+myId+'/profile').set(profile); }
    catch(e){ profileSaved=false; toast('Could not save to the cloud (' + (e&&e.code?e.code:'connection issue') + ') — check your connection and try again.'); }
    try{
      const existing = directoryDocs.find(d=>d._id===myId);
      const keep = directoryDefaults(existing);
      await db.doc('directory/'+myId).set({
        firstName: profile.firstName, lastName: profile.lastName, email: profile.email,
        stars: profile.stars||0, completedCount:(profile.completedLessons||[]).length,
        createdAt: profile.createdAt, lastActive: Date.now(), ...keep
      });
    }catch(e){}
  } else {
    try{ localStorage.setItem(LS_KEY, JSON.stringify(profile)); }
    catch(e){ profileSaved=false; toast('Could not save locally — your browser storage may be full or blocked.'); }
  }
  return profileSaved;
}

/* ============================= ROUTER ============================= */
window.addEventListener('hashchange', route);
function nav(hash){ location.hash = hash; }
function route(){
  mobileNavOpen=false;
  const h = location.hash || '#/';
  if(!loggedIn){
    if(h.startsWith('#/signup')) return renderAuthGate({screen:'signup'});
    if(h.startsWith('#/login')) return renderAuthGate({screen:'login'});
    if(h.startsWith('#/verify')) return renderAuthGate({screen:'verify'});
    if(h.startsWith('#/newpassword')) return renderAuthGate({screen:'newpassword'});
    if(h.startsWith('#/forgot')) return renderAuthGate({screen:'forgot'});
    return renderLanding();
  }
  return renderApp(h);
}
function render(){ route(); }

/* ============================= CONFETTI ============================= */
function fireConfetti(){
  const canvas = document.getElementById('confetti-canvas');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#E0A233','#EEBB5C','#5E2A92','#8C4FC4','#F5D08C','#3ECE7D'];
  const pieces = Array.from({length:140}, ()=>({
    x: Math.random()*canvas.width, y: -20-Math.random()*canvas.height*0.3,
    vx: (Math.random()-0.5)*4, vy: 2+Math.random()*4,
    size: 5+Math.random()*6, color: colors[Math.floor(Math.random()*colors.length)],
    rot: Math.random()*360, vr: (Math.random()-0.5)*10
  }));
  let frame=0;
  function tick(){
    frame++;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    pieces.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle=p.color; ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size*0.6);
      ctx.restore();
    });
    if(frame<130) requestAnimationFrame(tick); else ctx.clearRect(0,0,canvas.width,canvas.height);
  }
  tick();
}

/* ============================= AUTH SCREENS ============================= */
function renderAuthGate(opts){
  opts = opts||{};
  const root=document.getElementById('root');
  if(opts.loading){
    root.innerHTML = '<div class="auth-shell"><div class="auth-card" style="text-align:center;"><div class="brand" style="justify-content:center;"><span class="mark">J</span> JavaCur</div><p style="color:var(--ink-soft);margin-top:18px;">Loading your workspace…</p></div></div>';
    return;
  }
  const screen = opts.screen || 'signup';
  let body='';
  if(screen==='signup') body = signupFormHtml();
  else if(screen==='login') body = loginFormHtml();
  else if(screen==='verify') body = verifyFormHtml();
  else if(screen==='newpassword') body = newPasswordFormHtml();
  else if(screen==='forgot') body = forgotFormHtml();

  root.innerHTML = `
  <div class="auth-shell">
    <div class="auth-card">
      <div class="brand"><span class="mark">J</span> JavaCur</div>
      <div class="auth-sub">Java for the Curious</div>
      ${body}
    </div>
  </div>`;
  wireAuthForm(screen);
  wirePasswordToggles();
}

function wirePasswordToggles(){
  document.querySelectorAll('.pw-toggle').forEach(btn=>{
    btn.onclick=()=>{
      const input = document.getElementById(btn.dataset.target);
      if(!input) return;
      const showing = input.type==='text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    };
  });
}

function signupFormHtml(){
  return `
  <h3 style="margin-top:6px;">Create your account</h3>
  ${!dbAvailable?'<div class="form-note">The JavaCur server isn\'t reachable right now, so your account will be saved to this browser only. <b>Community features (forum, ratings, admin, the live class roster) will be hidden</b> until the server is running.</div>':''}
  <div id="authErr"></div>
  <form id="signupForm">
    <div class="field-row">
      <div class="field"><label>First name</label><input required name="firstName" autocomplete="given-name"></div>
      <div class="field"><label>Last name</label><input required name="lastName" autocomplete="family-name"></div>
    </div>
    <div class="field"><label>Date of birth</label><input required type="date" name="dob" max="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Email</label><input required type="email" name="email" autocomplete="email"></div>
    <div class="field"><label>Phone number <span style="font-weight:400;">(optional — lets you verify by text instead of email)</span></label><input type="tel" name="phone" placeholder="(555) 555-5555"></div>
    <div class="field-row">
      <div class="field"><label>Password</label><div class="password-field"><input required type="password" minlength="8" name="password" id="signupPw1" autocomplete="new-password"><button type="button" class="pw-toggle" data-target="signupPw1">Show</button></div></div>
      <div class="field"><label>Confirm password</label><div class="password-field"><input required type="password" minlength="8" name="password2" id="signupPw2" autocomplete="new-password"><button type="button" class="pw-toggle" data-target="signupPw2">Show</button></div></div>
    </div>
    <div class="field-hint" style="margin-bottom:16px;">At least 8 characters, with a letter and a number.</div>
    <button class="btn btn-gold btn-block" type="submit">Sign up</button>
  </form>
  <div class="switcher">Already have an account? <button id="toLogin">Log in</button></div>
  `;
}
function loginFormHtml(){
  return `
  <h3 style="margin-top:6px;">Welcome back</h3>
  <div class="auth-sub" style="margin-top:-10px;">Log in, then verify it's really you.</div>
  <div id="authErr"></div>
  <form id="loginForm">
    <div class="field"><label>Email</label><input required type="email" name="email" autocomplete="email"></div>
    <div class="field"><label>Password</label><div class="password-field"><input required type="password" name="password" id="loginPw" autocomplete="current-password"><button type="button" class="pw-toggle" data-target="loginPw">Show</button></div></div>
    <button class="btn btn-gold btn-block" type="submit">Log in</button>
  </form>
  <div class="switcher"><a href="#/forgot" id="toForgot">Forgot your password?</a></div>
  <div class="switcher">New to JavaCur? <button id="toSignup">Create an account</button></div>
  `;
}
function forgotFormHtml(){
  return `
  <h3 style="margin-top:6px;">Reset your password</h3>
  <div class="auth-sub" style="margin-top:-10px;">Enter your account email so we know whose password to reset.</div>
  <div id="authErr"></div>
  <form id="forgotForm">
    <div class="field"><label>Email</label><input required type="email" name="email" autocomplete="email" autofocus></div>
    <button class="btn btn-gold btn-block" type="submit">Continue</button>
  </form>
  <div class="switcher"><button id="backToLogin">Back to log in</button></div>
  `;
}
function newPasswordFormHtml(){
  return `
  <h3 style="margin-top:6px;">Choose a new password</h3>
  <div class="auth-sub" style="margin-top:-10px;">You're verified — set a new password to finish regaining access.</div>
  <div id="authErr"></div>
  <form id="newPasswordForm">
    <div class="field"><label>New password</label><div class="password-field"><input required type="password" minlength="8" name="password" id="newPw1" autocomplete="new-password"><button type="button" class="pw-toggle" data-target="newPw1">Show</button></div></div>
    <div class="field"><label>Confirm new password</label><div class="password-field"><input required type="password" minlength="8" name="password2" id="newPw2" autocomplete="new-password"><button type="button" class="pw-toggle" data-target="newPw2">Show</button></div></div>
    <div class="field-hint" style="margin-bottom:16px;">At least 8 characters, with a letter and a number.</div>
    <button class="btn btn-gold btn-block" type="submit">Save new password &amp; log in</button>
  </form>
  `;
}
function verifyFormHtml(){
  const hasPhone = (pendingSignupData && pendingSignupData.phone) || (profile && profile.phone);
  return `
  <h3 style="margin-top:6px;">Verify it's you</h3>
  <div class="auth-sub" style="margin-top:-10px;">Two-factor verification keeps your progress safe.</div>
  <div id="authErr"></div>
  <div class="method-toggle">
    <button type="button" data-method="email" class="method-btn ${(!pendingOTP||pendingOTP.method==='email')?'active':''}">📧 Email</button>
    <button type="button" data-method="phone" class="method-btn ${pendingOTP&&pendingOTP.method==='phone'?'active':''}" ${hasPhone?'':'disabled title="No phone on file"'}>📱 Phone</button>
  </div>
  <div class="form-note">Demo mode: this build can't send real emails or texts. Here's the code that would have been sent to your ${pendingOTP?pendingOTP.method:'email'}:</div>
  <div class="otp-code">${pendingOTP?pendingOTP.code:'------'}</div>
  <form id="verifyForm">
    <div class="field"><label>Enter the 6-digit code</label><input required maxlength="6" pattern="[0-9]{6}" name="code" inputmode="numeric" autocomplete="one-time-code"></div>
    <button class="btn btn-gold btn-block" type="submit">Verify &amp; continue</button>
  </form>
  <div class="switcher"><button id="resendCode">Resend code</button></div>
  `;
}

function wireAuthForm(screen){
  const errBox=()=>document.getElementById('authErr');
  const showErr=(msg)=>{ errBox().innerHTML = `<div class="form-error">${esc(msg)}</div>`; };

  if(screen==='signup'){
    document.getElementById('toLogin').onclick=()=>nav('#/login');
    document.getElementById('signupForm').onsubmit = async (e)=>{
      e.preventDefault();
      const f = new FormData(e.target);
      const firstName=f.get('firstName').trim(), lastName=f.get('lastName').trim();
      const dob=f.get('dob'), email=f.get('email').trim().toLowerCase();
      const phone=f.get('phone').trim();
      const pw=f.get('password'), pw2=f.get('password2');
      if(!firstName||!lastName) return showErr('Please enter your first and last name.');
      if(!dob || new Date(dob) > new Date()) return showErr('Please enter a valid date of birth.');
      if(!/^\S+@\S+\.\S+$/.test(email)) return showErr('Please enter a valid email address.');
      if(pw.length<8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return showErr('Password needs 8+ characters with a letter and a number.');
      if(pw!==pw2) return showErr('Passwords don\'t match.');
      if(dbAvailable){
        try{
          await adoptAccount(email);
          const existing = await db.doc('data/users/'+myId+'/profile').get();
          if(existing.exists) return showErr('An account with that email already exists — try logging in.');
        }catch(err){ return showErr('Could not reach the server (' + (err.code||err.message||'connection issue') + ').'); }
      }
      const passwordHash = await sha256(pw);
      pendingSignupData = {firstName,lastName,dob,email,phone,passwordHash};
      profile = {
        firstName,lastName,dob,email,phone,passwordHash,
        verified:false, createdAt:Date.now(), lastActive:Date.now(),
        stars:0, completedLessons:[], quizBest:{}, practiced:[], challengeWins:0, coursesCelebrated:[]
      };
      pendingOTP = {code:genCode(), method: phone? 'email':'email'};
      authFlowMode='signup';
      nav('#/verify');
    };
  }

  if(screen==='login'){
    document.getElementById('toSignup').onclick=()=>nav('#/signup');
    document.getElementById('loginForm').onsubmit = async (e)=>{
      e.preventDefault();
      const f=new FormData(e.target);
      const email=f.get('email').trim().toLowerCase(), pw=f.get('password');
      let acct=null, lookupErr=null;
      if(dbAvailable){
        try{ await adoptAccount(email); const s=await db.doc('data/users/'+myId+'/profile').get(); acct = s.exists? cloneData(s.data()): null; }catch(e){ lookupErr=e; }
      } else {
        try{ acct = JSON.parse(localStorage.getItem(LS_KEY)||'null'); }catch(e){}
      }
      if(lookupErr) return showErr('Could not check your account (' + (lookupErr.code||'connection issue') + ') — try again in a moment.');
      if(!acct || acct.email!==email) return showErr('No account found with that email.');

      if(dbAvailable){
        const dr = await freshDirRecord();
        if(dr && dr.lockedUntil && dr.lockedUntil>Date.now()){
          const mins = Math.ceil((dr.lockedUntil-Date.now())/60000);
          return showErr('This account is temporarily locked after too many failed attempts. Try again in about '+mins+' minute'+(mins===1?'':'s')+', use "Forgot your password?" below, or ask an admin to unlock you.');
        }
      }

      const hash = await sha256(pw);
      if(hash!==acct.passwordHash){
        if(dbAvailable){
          const dr = await freshDirRecord();
          const attempts = (dr && dr.failedAttempts || 0) + 1;
          const locked = attempts>=LOCK_THRESHOLD;
          try{
            await db.doc('directory/'+myId).update({
              failedAttempts: attempts,
              lockedUntil: locked ? Date.now()+LOCK_DURATION_MS : ((dr&&dr.lockedUntil)||null)
            });
          }catch(err){}
          if(locked) return showErr('Too many failed attempts — this account is now locked for 15 minutes. Use "Forgot your password?" below, or ask an admin to unlock you.');
          const left = LOCK_THRESHOLD-attempts;
          return showErr('Incorrect password. '+left+' attempt'+(left===1?'':'s')+' left before a temporary lock.');
        }
        return showErr('Incorrect password.');
      }
      if(dbAvailable){ try{ await db.doc('directory/'+myId).update({failedAttempts:0}); }catch(e){} }
      profile = acct;
      pendingOTP = {code:genCode(), method:'email'};
      authFlowMode='login';
      nav('#/verify');
    };
  }

  if(screen==='forgot'){
    document.getElementById('backToLogin').onclick=()=>nav('#/login');
    document.getElementById('forgotForm').onsubmit = async (e)=>{
      e.preventDefault();
      const f=new FormData(e.target);
      const email=f.get('email').trim().toLowerCase();
      if(!/^\S+@\S+\.\S+$/.test(email)) return showErr('Please enter a valid email address.');
      if(!dbAvailable){ showErr('Password reset needs the JavaCur server — make sure it is running.'); return; }
      try{
        await adoptAccount(email);
        const s = await db.doc('data/users/'+myId+'/profile').get();
        if(!s.exists){ showErr('No account found with that email — sign up first.'); return; }
        const acct = cloneData(s.data());
        if(acct.email!==email){ showErr('That email doesn\'t match this account.'); return; }
        profile = acct;
        pendingOTP = {code:genCode(), method:'email'};
        authFlowMode='reset';
        nav('#/verify');
      }catch(err){ showErr('Could not start password reset (' + (err&&err.code?err.code:'connection issue') + ') — try again in a moment.'); }
    };
  }

  if(screen==='verify'){
    document.querySelectorAll('.method-btn').forEach(b=>{
      b.onclick=()=>{ if(b.disabled) return; pendingOTP={code:genCode(), method:b.dataset.method}; renderAuthGate({screen:'verify'}); };
    });
    document.getElementById('resendCode').onclick=(e)=>{ e.preventDefault(); pendingOTP.code=genCode(); renderAuthGate({screen:'verify'}); toast('New code generated.'); };
    document.getElementById('verifyForm').onsubmit = async (e)=>{
      e.preventDefault();
      try{
        const f=new FormData(e.target);
        if(f.get('code')!==pendingOTP.code) return showErr('That code doesn\'t match — try again.');
        pendingOTP=null;
        if(authFlowMode==='reset'){
          nav('#/newpassword');
          route();
          return;
        }
        profile.verified=true;
        const saved = await saveProfile();
        if(!saved){ showErr('Could not save your account to the cloud — check your connection and try again.'); return; }
        loggedIn=true;
        sessionStorage.setItem('javacur_session','1');
        pendingSignupData=null;
        if(dbAvailable) startHeartbeat();
        toast('Welcome to JavaCur, '+profile.firstName+'! 🎉');
        nav('#/app');
        route();
      }catch(err){
        console.error('verify submit failed', err);
        showErr('Something went wrong verifying your code (' + (err&&err.message?err.message:'unknown error') + '). Please try again.');
      }
    };
  }

  if(screen==='newpassword'){
    document.getElementById('newPasswordForm').onsubmit = async (e)=>{
      e.preventDefault();
      try{
        const f=new FormData(e.target);
        const pw=f.get('password'), pw2=f.get('password2');
        if(pw.length<8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return showErr('Password needs 8+ characters with a letter and a number.');
        if(pw!==pw2) return showErr('Passwords don\'t match.');
        if(!profile){ showErr('We lost track of your account mid-reset — go back and start over from "Forgot your password?".'); return; }
        profile.passwordHash = await sha256(pw);
        profile.verified = true;
        const saved = await saveProfile();
        if(!saved){ showErr('Could not save your new password — check your connection and try again. Your old password still works for now.'); return; }
        if(dbAvailable){ try{ await db.doc('directory/'+myId).update({failedAttempts:0, lockedUntil:null}); }catch(err){} }
        loggedIn=true;
        sessionStorage.setItem('javacur_session','1');
        pendingSignupData=null; authFlowMode='login';
        if(dbAvailable) startHeartbeat();
        toast('Password updated — you\'re back in! 🎉');
        nav('#/app');
        route();
      }catch(err){
        console.error('newpassword submit failed', err);
        showErr('Something went wrong saving your password (' + (err&&err.message?err.message:'unknown error') + '). Please try again.');
      }
    };
  }
}

/* ============================= LANDING (public) ============================= */
function renderLanding(){
  const root=document.getElementById('root');
  root.innerHTML = `
  <div class="landing-nav">
    <div class="wrap">
      <div class="brand"><span class="mark">J</span> JavaCur</div>
      <div class="landing-nav-links">
        <button class="btn btn-ghost btn-sm" style="color:#fff;border-color:rgba(255,255,255,.3);" onclick="location.hash='#/login'">Log in</button>
        <button class="btn btn-gold btn-sm" onclick="location.hash='#/signup'">Sign up free</button>
      </div>
    </div>
  </div>

  <div class="hero">
    <div class="wrap hero-grid">
      <div>
        <div class="steam-badge">☕ Built for absolute beginners</div>
        <h1>Java for the curious, from your very first line of code.</h1>
        <p class="lead">JavaCur turns Java, Spring Boot, Angular, REST and Git into short, hands-on lessons — with your progress tracked, quizzes to check your understanding, and a friendly "beat the computer" game once you've learned something.</p>
        <div class="hero-cta">
          <button class="btn btn-gold" onclick="location.hash='#/signup'">Get started — it's free</button>
          <button class="btn btn-ghost" style="color:#fff;border-color:rgba(255,255,255,.35);" onclick="document.getElementById('whatinside').scrollIntoView({behavior:'smooth'})">See what's inside</button>
        </div>
      </div>
      <div class="hero-card">
        <h3>What you'll learn</h3>
        ${COURSE_ORDER.map(id=>`<div class="hero-stat-row"><span>${COURSES[id].icon} ${COURSES[id].title}</span><b>${Object.keys(COURSES[id].terms).length} lessons</b></div>`).join('')}
      </div>
    </div>
  </div>

  <div class="section wrap" id="whatinside">
    <div class="kicker">WHAT'S INSIDE</div>
    <h2>Everything a first-timer needs, nothing they don't.</h2>
    <div class="grid-4">
      <div class="feature-card"><div class="ic">📊</div><h4>Progress that's actually visible</h4><p>A dashboard tracks every lesson, quiz and star you've earned.</p></div>
      <div class="feature-card"><div class="ic">🔐</div><h4>Two-factor sign-in</h4><p>Verify by email or phone every time you sign on, so it's really you.</p></div>
      <div class="feature-card"><div class="ic">📱</div><h4>Phone or laptop</h4><p>A fully responsive layout that works wherever you're learning.</p></div>
      <div class="feature-card"><div class="ic">🧩</div><h4>Practice before it counts</h4><p>Unlimited practice quizzes before every graded quiz and exam.</p></div>
      <div class="feature-card"><div class="ic">🎉</div><h4>Confetti &amp; stars</h4><p>Finish a section and watch the celebration — plus a star to show for it.</p></div>
      <div class="feature-card"><div class="ic">🤖</div><h4>Beat the computer</h4><p>An optional speed challenge for fun — winning or losing never affects your progress.</p></div>
      <div class="feature-card"><div class="ic">💬</div><h4>Ask anything</h4><p>A community Q&amp;A board for when you're stuck.</p></div>
      <div class="feature-card"><div class="ic">🔎</div><h4>Search everything</h4><p>Jump straight to any term or lesson from the search bar.</p></div>
    </div>
  </div>

  <div class="section wrap" style="background:var(--cream-dim); border-radius:var(--radius-l);">
    <div class="kicker">LEARNING STYLES</div>
    <h2>Read it, picture it, try it, keep it.</h2>
    <div class="style-row">
      <div class="style-pill"><div class="ic">📖</div><h4>Read</h4><p>A clear, plain-language definition for every concept.</p></div>
      <div class="style-pill"><div class="ic">🧠</div><h4>Picture it</h4><p>A real-world analogy so abstract ideas finally click.</p></div>
      <div class="style-pill"><div class="ic">💻</div><h4>See the code</h4><p>A short, real example you can study line by line.</p></div>
      <div class="style-pill"><div class="ic">⭐</div><h4>Why it matters</h4><p>A one-line reason this concept actually shows up in real work.</p></div>
    </div>
  </div>

  <div class="section wrap">
    <div class="kicker">THE FULL PATH</div>
    <h2>Four courses, built from a real onboarding plan.</h2>
    <div class="grid-3">
      ${COURSE_ORDER.map(id=>`<div class="feature-card"><div class="ic">${COURSES[id].icon}</div><h4>${COURSES[id].title}</h4><p>${COURSES[id].blurb}</p></div>`).join('')}
    </div>
  </div>

  <div class="section wrap" style="text-align:center;">
    <h2 style="margin:0 auto .3em;">Curious yet?</h2>
    <p style="color:var(--ink-soft); max-width:50ch; margin:0 auto 24px;">Create a free account to unlock every lesson, quiz and challenge. You can look around this page any time — you just need to sign in to actually use JavaCur.</p>
    <button class="btn btn-gold" onclick="location.hash='#/signup'">Sign up free</button>
  </div>

  <footer class="site-footer">
    <div class="wrap">
      <div>© ${new Date().getFullYear()} JavaCur — Java for the Curious</div>
      <div>${dbAvailable? 'Cloud sync: connected' : 'Preview mode: saved to this browser only'}</div>
    </div>
  </footer>
  `;
}

/* ============================= APP SHELL ============================= */
function renderApp(hash){
  const root=document.getElementById('root');
  const path = hash.replace('#/app','').replace(/^\//,'').split('/').filter(Boolean);
  const view = path[0] || 'dashboard';

  root.innerHTML = `
  <div class="app-shell">
    <div class="topbar">
      <div class="topbar-inner">
        <div class="brand"><span class="mark">J</span> JavaCur</div>
        <div class="search-box">
          <span class="sic">🔎</span>
          <input id="searchInput" placeholder="Search lessons, terms…" autocomplete="off">
          <div id="searchResults"></div>
        </div>
        <button class="mobile-toggle" id="mobileToggle">☰</button>
        <div class="topnav-links" id="topnavLinks">
          <a href="#/app" class="${view==='dashboard'?'active':''}">Dashboard</a>
          <a href="#/app/courses" class="${view==='courses'?'active':''}">Courses</a>
          ${dbAvailable?`<a href="#/app/forum" class="${view==='forum'?'active':''}">Forum</a>`:''}
          ${dbAvailable?`<a href="#/app/ratings" class="${view==='ratings'?'active':''}">Rate Us</a>`:''}
          ${dbAvailable && isAppAdmin()?`<a href="#/app/admin" class="${view==='admin'?'active':''}">Admin</a>`:''}
          <a href="#" id="signOutLink">Sign off</a>
        </div>
        ${dbAvailable?`<div class="online-chip"><span class="online-dot"></span>${onlineCount()} learning now</div>`:''}
        <div class="star-chip">⭐ ${profile.stars||0}</div>
      </div>
    </div>
    <main class="app-main"><div class="wrap" id="mainContent"></div></main>
  </div>`;

  document.getElementById('mobileToggle').onclick=()=>{ document.getElementById('topnavLinks').classList.toggle('open'); };
  document.getElementById('signOutLink').onclick=(e)=>{ e.preventDefault(); signOff(); };
  wireSearch();

  const content = document.getElementById('mainContent');
  if(view==='dashboard') return renderDashboard(content);
  if(view==='courses' && !path[1]) return renderCoursesList(content);
  if(view==='course' && path[1]) return renderCourseDetail(content, path[1]);
  if(view==='lesson' && path[1] && path[2]) return renderLesson(content, path[1], decodeURIComponent(path[2]));
  if(view==='quiz' && path[1] && path[2]) return renderQuiz(content, path[1], path[2]);
  if(view==='challenge' && path[1]) return renderChallenge(content, path[1], path[2]?decodeURIComponent(path[2]):null);
  if(view==='forum' && dbAvailable) return renderForum(content);
  if(view==='ratings' && dbAvailable) return renderRatings(content);
  if(view==='admin' && dbAvailable && isAppAdmin()) return renderAdmin(content);
  return renderDashboard(content);
}

function signOff(){
  sessionStorage.removeItem('javacur_session');
  loggedIn=false;
  if(heartbeatTimer) clearInterval(heartbeatTimer);
  nav('#/');
  toast('Signed off. See you soon!');
}

function onlineCount(){
  const cutoff = Date.now() - 2*60*1000;
  return directoryDocs.filter(d=>d.lastActive && d.lastActive>=cutoff).length || (profile?1:0);
}

/* ---- search ---- */
function wireSearch(){
  const input=document.getElementById('searchInput');
  const results=document.getElementById('searchResults');
  input.oninput=()=>{
    const q=input.value.trim().toLowerCase();
    if(!q){ results.innerHTML=''; results.className=''; return; }
    const hits=[];
    allCourses().forEach(c=>{
      lessonsForCourse(c.id).forEach(l=>{
        if(l.term.toLowerCase().includes(q) || l.definition.toLowerCase().includes(q)){
          hits.push({courseId:c.id, courseTitle:c.title, term:l.term, def:l.definition});
        }
      });
    });
    if(!hits.length){ results.className='search-results'; results.innerHTML='<div class="sr-item">No matches.</div>'; return; }
    results.className='search-results';
    results.innerHTML = hits.slice(0,10).map(h=>`<div class="sr-item" data-c="${esc(h.courseId)}" data-t="${esc(h.term)}"><b>${esc(h.term)}</b>${esc(h.courseTitle)} — ${esc(h.def.slice(0,70))}${h.def.length>70?'…':''}</div>`).join('');
    results.querySelectorAll('.sr-item[data-c]').forEach(it=>{
      it.onclick=()=>{ nav('#/app/lesson/'+it.dataset.c+'/'+encodeURIComponent(it.dataset.t)); results.innerHTML=''; input.value=''; };
    });
  };
  document.addEventListener('click', function outside(e){
    if(!input.contains(e.target) && !results.contains(e.target)){ results.innerHTML=''; }
  });
}

/* ---- dashboard ---- */
function renderDashboard(el){
  const tp = totalProgress();
  el.innerHTML = `
  <div class="page-head"><div><h1 style="margin-bottom:2px;">Welcome back, ${esc(profile.firstName)} 👋</h1><div style="color:var(--ink-soft);font-size:.92rem;">${tp.done} of ${tp.total} lessons complete</div></div>
    <button class="btn btn-gold" onclick="window.__goContinue()">Continue learning</button>
  </div>
  <div class="dash-grid">
    <div class="panel">
      <h3>Your courses</h3>
      ${allCourses().map(c=>{
        const p=courseProgress(c.id);
        return `<div class="course-row" style="cursor:pointer;" onclick="location.hash='#/app/course/${esc(c.id)}'">
          <div class="ic">${c.icon}</div>
          <div class="meta"><h4>${esc(c.title)}</h4>
            <div class="progress-track"><div class="progress-fill" style="width:${p.pct}%"></div></div>
            <div class="small-note">${p.done}/${p.total} lessons</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="panel">
      <h3>Your stats</h3>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${profile.stars||0}</div><div class="lbl">Stars</div></div>
        <div class="stat-box"><div class="num">${profile.challengeWins||0}</div><div class="lbl">Boss wins</div></div>
        <div class="stat-box"><div class="num">${tp.pct}%</div><div class="lbl">Overall</div></div>
        <div class="stat-box"><div class="num">${Object.values(profile.quizBest||{}).filter(c=>(c.exam||0)>=70).length}</div><div class="lbl">Exams passed</div></div>
      </div>
      <hr class="rule">
      <div class="small-note">Signed up ${fmtDate(profile.createdAt)}</div>
      ${!dbAvailable?'<div class="form-note" style="margin-top:14px;">Preview mode — progress is saved to this browser only.</div>':''}
    </div>
  </div>`;
}
window.__goContinue = function(){
  for(const c of allCourses()){
    const lessons = lessonsForCourse(c.id);
    const next = lessons.find(l=> !(profile.completedLessons||[]).includes(c.id+'::'+l.key));
    if(next){ nav('#/app/lesson/'+c.id+'/'+encodeURIComponent(next.key)); return; }
  }
  nav('#/app/courses');
};

/* ---- courses list ---- */
function renderCoursesList(el){
  el.innerHTML = `
  <div class="page-head"><h1>Courses</h1></div>
  <div class="course-cards">
    ${allCourses().map(c=>{
      const p=courseProgress(c.id);
      return `<div class="course-card" onclick="location.hash='#/app/course/${esc(c.id)}'">
        <div class="top"><div class="ic">${c.icon}</div><div><h4 style="margin:0;">${esc(c.title)}${p.total>0&&p.done===p.total?' 🏆':''}</h4><div class="small-note">${p.total} lessons</div></div></div>
        <p>${esc(c.blurb)}</p>
        <div class="progress-track"><div class="progress-fill" style="width:${p.pct}%"></div></div>
        <div class="small-note" style="margin-top:6px;">${p.done}/${p.total} complete</div>
      </div>`;
    }).join('')}
  </div>`;
}

/* ---- course detail ---- */
function renderCourseDetail(el, courseId){
  const meta = courseMeta(courseId);
  const lessons = lessonsForCourse(courseId);
  const p = courseProgress(courseId);
  el.innerHTML = `
  <div class="crumb"><a onclick="location.hash='#/app/courses'">Courses</a> / ${esc(meta.title)}</div>
  <div class="page-head">
    <div><h1>${meta.icon} ${esc(meta.title)}</h1><p style="color:var(--ink-soft); max-width:60ch;">${esc(meta.blurb)}</p></div>
  </div>
  <div class="panel" style="margin-bottom:20px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;"><b>${p.done}/${p.total} lessons complete</b><span>${p.pct}%</span></div>
    <div class="progress-track"><div class="progress-fill" style="width:${p.pct}%"></div></div>
    ${p.total>0 && p.done===p.total ? '<div class="badge-earned" style="margin-top:14px;">🏆 Course complete — every lesson finished!</div>' : ''}
  </div>
  <div class="lesson-list">
    ${lessons.map(l=>{
      const done = (profile.completedLessons||[]).includes(courseId+'::'+l.key);
      return `<div class="lesson-item" onclick="location.hash='#/app/lesson/${esc(courseId)}/${encodeURIComponent(l.key)}'">
        <div class="lesson-check ${done?'done':''}">${done?'✓':''}</div>
        <div class="title">${esc(l.term)}</div>
        <div class="arrow">›</div>
      </div>`;
    }).join('')}
  </div>
  <div class="lesson-actions">
    <button class="btn btn-purple" onclick="location.hash='#/app/quiz/${esc(courseId)}/practice'">📝 Practice quiz</button>
    <button class="btn btn-gold" onclick="location.hash='#/app/quiz/${esc(courseId)}/exam'">🎓 Take the exam</button>
  </div>`;
}

/* ---- lesson detail ---- */
let currentTab='read';
let viewedTabs=[];
const ALL_TABS=['read','visual','code','why'];
const TAB_LABEL={read:'📖 Read', visual:'🧠 Picture it', code:'💻 See the code', why:'⭐ Why it matters'};

async function checkCourseCelebration(courseId){
  const p = courseProgress(courseId);
  if(p.total>0 && p.done===p.total){
    profile.coursesCelebrated = profile.coursesCelebrated||[];
    if(!profile.coursesCelebrated.includes(courseId)){
      profile.coursesCelebrated.push(courseId);
      await saveProfile();
      fireConfetti();
      const meta = courseMeta(courseId);
      toast('🏆 Course complete: '+meta.title+'! Every lesson done.');
      return true;
    }
  }
  return false;
}

function renderLesson(el, courseId, termKey){
  currentTab='read';
  viewedTabs=['read'];
  const lessons = lessonsForCourse(courseId);
  const lesson = lessons.find(l=>l.key===termKey);
  const meta = courseMeta(courseId);
  if(!lesson){ el.innerHTML='<div class="empty-state">Lesson not found.</div>'; return; }
  const lessonKey = courseId+'::'+lesson.key;
  let done = (profile.completedLessons||[]).includes(lessonKey);
  if(done) viewedTabs = ALL_TABS.slice();

  const defKeywords = keywordsFromText(lesson.definition);
  const codeKeywords = keywordsFromCode(lesson.example);
  const templates = challengeTemplatesFor(courseId);
  let ownWordsDraft='', ownWordsFeedback=null;
  let challengeIdx=0, codePracticeDraft='', codeFeedback=null;

  function progressLine(){
    if(done) return `<div class="badge-earned">⭐ Section complete — nice work!</div>`;
    const seen = ALL_TABS.filter(t=>viewedTabs.includes(t)).length;
    return `<div class="form-note">This section completes automatically once you've viewed all 4 tabs above. Viewed ${seen}/4 — visit "${TAB_LABEL[ALL_TABS.find(t=>!viewedTabs.includes(t))]}" next.</div>`;
  }

  function ownWordsFeedbackHtml(){
    if(!ownWordsFeedback) return '';
    return `<div class="quiz-feedback ${ownWordsFeedback.ok?'ok':'bad'}" style="margin-top:10px;">
      ${ownWordsFeedback.ok? 'Nice — that captures the key idea!' : "Close, but you're missing a few key ideas. Here's the definition again:"}
      ${!ownWordsFeedback.ok? `<div style="margin-top:6px;">${esc(lesson.definition)}</div>` : ''}
      <div class="small-note" style="margin-top:6px;">Lightweight check — not a real grader, just a helpful nudge.</div>
    </div>`;
  }
  function codeFeedbackHtml(){
    if(!codeFeedback) return '';
    return `<div class="quiz-feedback ${codeFeedback.ok?'ok':'bad'}" style="margin-top:10px;">
      ${codeFeedback.ok? 'Nice — that looks like a solid attempt!' : 'Not quite there yet — compare against the example above and try again.'}
      <div class="small-note" style="margin-top:6px;">Lightweight keyword check (${codeFeedback.hit}/${codeFeedback.total} key pieces found) — not a real compiler.</div>
    </div>`;
  }

  function tabs(){
    return `
    <div class="panel">
      <div class="crumb"><a onclick="location.hash='#/app/course/${esc(courseId)}'">${esc(meta.title)}</a> / ${esc(lesson.term)}</div>
      <h1 style="margin-bottom:14px;">${esc(lesson.term)}</h1>
      <div class="tabs">
        <button class="tab-btn ${currentTab==='read'?'active':''}" data-tab="read">📖 Read${viewedTabs.includes('read')?' ✓':''}</button>
        <button class="tab-btn ${currentTab==='visual'?'active':''}" data-tab="visual">🧠 Picture it${viewedTabs.includes('visual')?' ✓':''}</button>
        <button class="tab-btn ${currentTab==='code'?'active':''}" data-tab="code">💻 See the code${viewedTabs.includes('code')?' ✓':''}</button>
        <button class="tab-btn ${currentTab==='why'?'active':''}" data-tab="why">⭐ Why it matters${viewedTabs.includes('why')?' ✓':''}</button>
      </div>
      <div class="lesson-body">
        <div class="tab-panel ${currentTab==='read'?'active':''}" data-panel="read">
          <div id="defWrap" style="${ownWordsDraft.trim()?'display:none;':''}">
            <p id="defParagraph">${esc(lesson.definition)}</p>
          </div>
          <div id="defHiddenNote" class="small-note" style="${ownWordsDraft.trim()?'':'display:none;'} margin-bottom:10px;">🙈 Definition hidden while you're writing — clear the box to see it again.</div>
          <div class="practice-box">
            <h4 style="margin-top:0;">✍️ Try it in your own words</h4>
            <p class="small-note">Explain what "${esc(lesson.term)}" means, without looking back — then check yourself.</p>
            <textarea id="ownWordsInput" rows="3" placeholder="Type your own explanation here…">${esc(ownWordsDraft)}</textarea>
            <div class="lesson-actions" style="margin-top:10px;"><button class="btn btn-purple btn-sm" id="checkOwnWords">Check my explanation</button></div>
            ${ownWordsFeedbackHtml()}
          </div>
        </div>
        <div class="tab-panel ${currentTab==='visual'?'active':''}" data-panel="visual">
          <p>${esc(lesson.analogy)}</p>
          <hr class="rule">
          <h4>🧒 Explain it like a first grader</h4>
          <p>${esc(lesson.simple || 'No kid-friendly version yet for this one.')}</p>
        </div>
        <div class="tab-panel ${currentTab==='code'?'active':''}" data-panel="code">
          <pre>${esc(lesson.example)}</pre>
          <div class="practice-box">
            <h4 style="margin-top:0;">🧪 Your turn — write it yourself</h4>
            <p class="small-note">${esc(templates[challengeIdx].replace('{term}', lesson.term))}</p>
            <div class="lesson-actions" style="margin:8px 0;"><button class="btn btn-ghost btn-sm" id="shuffleChallenge">🔀 Shuffle challenge</button></div>
            <textarea id="codePracticeInput" class="code-answer" rows="6" placeholder="Write your code here…">${esc(codePracticeDraft)}</textarea>
            <div class="lesson-actions" style="margin-top:10px;"><button class="btn btn-purple btn-sm" id="checkCodePractice">Check my code</button></div>
            ${codeFeedbackHtml()}
          </div>
        </div>
        <div class="tab-panel ${currentTab==='why'?'active':''}" data-panel="why"><p>${esc(lesson.tip)}</p></div>
      </div>
      ${progressLine()}
      <div class="lesson-actions">
        ${done?`<button class="btn btn-purple" onclick="location.hash='#/app/challenge/${esc(courseId)}/${encodeURIComponent(lesson.key)}'">🤖 Challenge the computer (just for fun)</button>`:''}
        <button class="btn btn-ghost" onclick="location.hash='#/app/course/${esc(courseId)}'">Back to course</button>
      </div>
    </div>`;
  }
  el.innerHTML = tabs();

  async function maybeAutoComplete(){
    if(done) return;
    if(ALL_TABS.every(t=>viewedTabs.includes(t))){
      profile.completedLessons = profile.completedLessons||[];
      if(!profile.completedLessons.includes(lessonKey)){
        profile.completedLessons.push(lessonKey);
        profile.stars = (profile.stars||0)+1;
        done = true;
        await saveProfile();
        fireConfetti();
        toast('⭐ Section complete! You earned a star.');
        await checkCourseCelebration(courseId);
      }
    }
  }

  function wire(){
    el.querySelectorAll('.tab-btn').forEach(b=>{
      b.onclick=async ()=>{
        currentTab=b.dataset.tab;
        if(!viewedTabs.includes(currentTab)) viewedTabs.push(currentTab);
        await maybeAutoComplete();
        el.innerHTML=tabs(); wire();
      };
    });
    const ownWordsInput = document.getElementById('ownWordsInput');
    if(ownWordsInput){
      ownWordsInput.oninput=()=>{
        ownWordsDraft = ownWordsInput.value;
        const writing = ownWordsDraft.trim().length>0;
        const defWrap = document.getElementById('defWrap');
        const defNote = document.getElementById('defHiddenNote');
        if(defWrap) defWrap.style.display = writing ? 'none' : '';
        if(defNote) defNote.style.display = writing ? '' : 'none';
      };
    }
    const ownWordsBtn = document.getElementById('checkOwnWords');
    if(ownWordsBtn){
      ownWordsBtn.onclick=()=>{
        ownWordsDraft = document.getElementById('ownWordsInput').value;
        ownWordsFeedback = checkCoverage(ownWordsDraft, defKeywords, 0.4);
        el.innerHTML=tabs(); wire();
      };
    }
    const shuffleBtn = document.getElementById('shuffleChallenge');
    if(shuffleBtn){
      shuffleBtn.onclick=()=>{
        codePracticeDraft = document.getElementById('codePracticeInput').value;
        let next = Math.floor(Math.random()*templates.length);
        if(templates.length>1){ while(next===challengeIdx) next = Math.floor(Math.random()*templates.length); }
        challengeIdx = next;
        codeFeedback = null;
        el.innerHTML=tabs(); wire();
      };
    }
    const checkCodeBtn = document.getElementById('checkCodePractice');
    if(checkCodeBtn){
      checkCodeBtn.onclick=()=>{
        codePracticeDraft = document.getElementById('codePracticeInput').value;
        codeFeedback = checkCoverage(codePracticeDraft, codeKeywords, 0.35);
        el.innerHTML=tabs(); wire();
      };
    }
  }
  wire();
}

/* ---- quiz / exam ---- */
function buildMCBank(courseId){
  const lessons = lessonsForCourse(courseId);
  const extra = customQuestions.filter(q=>q.courseId===courseId && q.type==='mc');
  const bank = lessons.map(l=>{
    const distractors = lessons.filter(x=>x.key!==l.key).map(x=>x.definition);
    shuffle(distractors);
    const opts = shuffle([l.definition, ...distractors.slice(0,3)]);
    return {prompt:'What does "'+l.term+'" mean?', options:opts, correct: opts.indexOf(l.definition), explanation: l.analogy};
  });
  extra.forEach(q=> bank.push({prompt:q.prompt, options:q.options, correct:q.correctIndex, explanation:q.explanation||''}));
  return bank;
}
function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

function renderQuiz(el, courseId, mode){
  const meta = courseMeta(courseId);
  let bank = shuffle(buildMCBank(courseId));
  let codeQ = CODE_QUESTIONS[courseId];
  const customCode = customQuestions.filter(q=>q.courseId===courseId && q.type==='code');
  if(customCode.length) codeQ = customCode[Math.floor(Math.random()*customCode.length)];

  if(mode==='exam'){ bank = bank.slice(0, Math.min(8,bank.length)); }
  else { bank = bank.slice(0, Math.min(bank.length, 12)); }

  quizState = {courseId, mode, bank, idx:0, correctCount:0, showingCode:false, codeQ, finished:false, codePassed:null};
  paintQuiz(el, meta);
}
function paintQuiz(el, meta){
  const qs = quizState;
  if(qs.finished){
    const pct = Math.round(qs.correctCount / (qs.bank.length + (qs.codeQ?1:0)) * 100);
    profile.quizBest = profile.quizBest || {};
    profile.quizBest[qs.courseId] = profile.quizBest[qs.courseId] || {practice:0, exam:0};
    const prevBest = profile.quizBest[qs.courseId][qs.mode] || 0;
    const best = Math.max(prevBest, pct);
    profile.quizBest[qs.courseId][qs.mode] = best;
    if(qs.mode==='practice' && !profile.practiced.includes(qs.courseId)) profile.practiced.push(qs.courseId);
    saveProfile();
    const passed = best>=70;
    const isNewBest = pct>=prevBest;
    el.innerHTML = `
    <div class="panel" style="text-align:center;">
      <h1>${qs.mode==='exam'?'🎓 Exam':'📝 Practice'} results</h1>
      <div style="font-size:3rem; font-family:'Fraunces',serif; color:var(--purple-700); margin:10px 0;">${pct}%</div>
      <p style="color:var(--ink-soft);">${qs.correctCount} of ${qs.bank.length + (qs.codeQ?1:0)} correct</p>
      <p class="small-note">Your best score on this ${qs.mode}: <b>${best}%</b>${isNewBest && prevBest>0 ? ' — new personal best! 🎉' : ''} (we always keep your highest score, no matter how many times you retake it)</p>
      ${qs.mode==='exam' ? (passed? '<div class="badge-earned" style="justify-content:center;">🏆 You\'ve passed this exam!</div>' : '<div class="form-note">Not quite 70% yet — head back to practice mode and try again whenever you\'re ready.</div>') : '<div class="form-note">Practice complete! Retake any time, or head to the exam when you feel ready.</div>'}
      <div class="lesson-actions" style="justify-content:center; margin-top:20px;">
        <button class="btn btn-purple" onclick="location.hash='#/app/quiz/${esc(qs.courseId)}/${qs.mode}'">Try again</button>
        <button class="btn btn-ghost" onclick="location.hash='#/app/course/${esc(qs.courseId)}'">Back to course</button>
      </div>
    </div>`;
    return;
  }
  if(qs.idx >= qs.bank.length && qs.codeQ && !qs.showingCode && qs.codePassed===null){
    qs.showingCode=true;
    el.innerHTML = `
    <div class="panel">
      <div class="quiz-progress">Bonus: write some code</div>
      <h3>${esc(qs.codeQ.prompt)}</h3>
      <textarea class="code-answer" id="codeInput" placeholder="Type your answer here…"></textarea>
      <div class="lesson-actions"><button class="btn btn-gold" id="submitCode">Submit</button></div>
      <div id="codeFeedback"></div>
    </div>`;
    document.getElementById('submitCode').onclick=()=>{
      const val = document.getElementById('codeInput').value.toLowerCase();
      const hitCount = qs.codeQ.keywords.filter(k=>val.includes(k.toLowerCase())).length;
      const passed = hitCount >= Math.ceil(qs.codeQ.keywords.length*0.6);
      qs.codePassed = passed;
      if(passed) qs.correctCount++;
      document.getElementById('codeFeedback').innerHTML = `
        <div class="quiz-feedback ${passed?'ok':'bad'}">${passed?'Nice — that covers the key pieces!':'Not quite — here\'s a model answer:'}</div>
        <pre style="margin-top:10px;">${esc(qs.codeQ.explanation)}</pre>
        <div class="lesson-actions"><button class="btn btn-purple" id="nextAfterCode">Continue</button></div>`;
      document.getElementById('nextAfterCode').onclick=()=>{ qs.finished=true; paintQuiz(el, meta); };
      document.getElementById('submitCode').disabled=true;
    };
    return;
  }
  if(qs.idx >= qs.bank.length){ qs.finished=true; return paintQuiz(el, meta); }

  const q = qs.bank[qs.idx];
  el.innerHTML = `
  <div class="panel">
    <div class="quiz-progress">${meta.title} · ${qs.mode==='exam'?'Exam':'Practice'} — question ${qs.idx+1} of ${qs.bank.length}${qs.codeQ?' + 1 bonus':''}</div>
    <div class="quiz-q">${esc(q.prompt)}</div>
    <div class="quiz-opts">${q.options.map((o,i)=>`<button class="opt-btn" data-i="${i}">${esc(o)}</button>`).join('')}</div>
    <div id="qFeedback"></div>
  </div>`;
  el.querySelectorAll('.opt-btn').forEach(btn=>{
    btn.onclick=()=>{
      const i = parseInt(btn.dataset.i);
      el.querySelectorAll('.opt-btn').forEach(b=>b.disabled=true);
      if(i===q.correct){ btn.classList.add('correct'); qs.correctCount++; }
      else { btn.classList.add('wrong'); el.querySelectorAll('.opt-btn')[q.correct].classList.add('correct'); }
      document.getElementById('qFeedback').innerHTML = `
        <div class="quiz-feedback ${i===q.correct?'ok':'bad'}">${i===q.correct?'Correct! ':'Not quite. '}${esc(q.explanation||'')}</div>
        <div class="lesson-actions"><button class="btn btn-purple" id="nextQ">${qs.idx+1<qs.bank.length || qs.codeQ ? 'Next':'See results'}</button></div>`;
      document.getElementById('nextQ').onclick=()=>{ qs.idx++; paintQuiz(el, meta); };
    };
  });
}

/* ---- challenge the computer ---- */
function renderChallenge(el, courseId, termKey){
  const bank = shuffle(buildMCBank(courseId)).slice(0,5);
  challengeState = {courseId, bank, idx:0, playerCorrect:0, playerTime:0, compTime:0, running:false, startedAt:0};
  paintChallenge(el);
}
function paintChallenge(el){
  const cs = challengeState;
  const meta = courseMeta(cs.courseId);
  if(cs.idx >= cs.bank.length){
    const playerWon = cs.playerCorrect===cs.bank.length && cs.playerTime < cs.compTime;
    if(playerWon){ profile.challengeWins=(profile.challengeWins||0)+1; saveProfile(); }
    el.innerHTML = `
    <div class="panel" style="text-align:center;">
      <div style="font-size:3rem;">${playerWon?'🏆':'🙂'}</div>
      <h1>${playerWon? 'You beat the computer!':'Good round!'}</h1>
      <p style="color:var(--ink-soft);">You: ${cs.playerCorrect}/${cs.bank.length} correct in ${(cs.playerTime/1000).toFixed(1)}s · Computer: ${(cs.compTime/1000).toFixed(1)}s</p>
      <p class="small-note">Remember — this is just for fun. Your section is already marked complete either way.</p>
      <div class="lesson-actions" style="justify-content:center; margin-top:16px;">
        <button class="btn btn-purple" onclick="location.hash='#/app/challenge/${esc(cs.courseId)}'">Play again</button>
        <button class="btn btn-ghost" onclick="location.hash='#/app/course/${esc(cs.courseId)}'">Back to course</button>
      </div>
    </div>`;
    return;
  }
  const q = cs.bank[cs.idx];
  const compAnswerMs = 3000 + Math.random()*3000;
  el.innerHTML = `
  <div class="panel">
    <div class="quiz-progress">🤖 Beat the computer — ${meta.title} — question ${cs.idx+1} of ${cs.bank.length}</div>
    <div class="challenge-race">
      <div class="racer"><div class="ic">🧑</div><div>You</div><div class="bar"><div id="playerBar"></div></div></div>
      <div class="racer"><div class="ic">🤖</div><div>Computer</div><div class="bar"><div id="compBar"></div></div></div>
    </div>
    <div class="quiz-q">${esc(q.prompt)}</div>
    <div class="quiz-opts">${q.options.map((o,i)=>`<button class="opt-btn" data-i="${i}">${esc(o)}</button>`).join('')}</div>
  </div>`;
  const t0 = performance.now();
  let compDone=false, playerDone=false;
  const compTimer = setInterval(()=>{
    const el2=document.getElementById('compBar'); if(!el2) return clearInterval(compTimer);
    const elapsed = performance.now()-t0;
    el2.style.width = Math.min(100, elapsed/compAnswerMs*100)+'%';
    if(elapsed>=compAnswerMs && !compDone){ compDone=true; clearInterval(compTimer); if(!playerDone) cs.compTime += compAnswerMs; }
  },50);
  el.querySelectorAll('.opt-btn').forEach(btn=>{
    btn.onclick=()=>{
      if(playerDone) return; playerDone=true;
      const elapsed = performance.now()-t0;
      document.getElementById('playerBar').style.width='100%';
      const i=parseInt(btn.dataset.i);
      el.querySelectorAll('.opt-btn').forEach(b=>b.disabled=true);
      if(i===q.correct){ btn.classList.add('correct'); cs.playerCorrect++; cs.playerTime += elapsed; }
      else { btn.classList.add('wrong'); el.querySelectorAll('.opt-btn')[q.correct].classList.add('correct'); cs.playerTime += Math.max(elapsed, compAnswerMs+500); }
      setTimeout(()=>{ cs.idx++; paintChallenge(el); }, 900);
    };
  });
}

/* ---- forum ---- */
function renderForum(el){
  el.innerHTML = `
  <div class="page-head"><h1>💬 Ask &amp; discuss</h1></div>
  <div class="panel">
    <form id="newPostForm">
      <div class="field"><textarea name="text" required placeholder="Ask a question or share something you learned…" rows="3"></textarea></div>
      <button class="btn btn-gold" type="submit">Post</button>
    </form>
  </div>
  <div class="panel" style="margin-top:18px;">
    ${forumPosts.length? forumPosts.map(p=>forumPostHtml(p)).join('') : '<div class="empty-state"><div class="ic">💬</div>No posts yet — be the first to ask something!</div>'}
  </div>`;
  document.getElementById('newPostForm').onsubmit = async (e)=>{
    e.preventDefault();
    const text = new FormData(e.target).get('text').trim();
    if(!text) return;
    try{
      await db.collection('forum_posts').add({authorId:myId, authorName:profile.firstName+' '+profile.lastName.charAt(0)+'.', text, createdAt:Date.now(), replies:[]});
      e.target.reset(); toast('Posted!');
    }catch(err){ toast('Could not post — try again.'); }
  };
  wireForumActions(el);
}
function forumPostHtml(p){
  const replies = p.replies||[];
  return `
  <div class="forum-post" data-id="${esc(p._id)}">
    <div class="meta">${esc(p.authorName)} · ${timeAgo(p.createdAt)}</div>
    <div class="txt">${esc(p.text)}</div>
    ${replies.map(r=>`<div class="forum-reply"><b>${esc(r.authorName)}:</b> ${esc(r.text)}</div>`).join('')}
    <div class="forum-actions">
      <button class="reply-btn" data-id="${esc(p._id)}">Reply</button>
      ${hasPerm('forum')?`<button class="del-post-btn" data-id="${esc(p._id)}" style="color:var(--bad);">Delete</button>`:''}
    </div>
    <div class="reply-form-slot" data-id="${esc(p._id)}"></div>
  </div>`;
}
function wireForumActions(el){
  el.querySelectorAll('.reply-btn').forEach(b=>{
    b.onclick=()=>{
      const slot = el.querySelector('.reply-form-slot[data-id="'+b.dataset.id+'"]');
      if(slot.innerHTML){ slot.innerHTML=''; return; }
      slot.innerHTML = `<form class="reply-form" style="margin:8px 0 0 20px; display:flex; gap:8px;"><input required placeholder="Write a reply…" style="flex:1; padding:.5em .7em; border-radius:8px; border:1.5px solid var(--panel-line);"><button class="btn btn-sm btn-purple" type="submit">Send</button></form>`;
      slot.querySelector('form').onsubmit=async (e)=>{
        e.preventDefault();
        const val = e.target.querySelector('input').value.trim();
        if(!val) return;
        const post = forumPosts.find(x=>x._id===b.dataset.id);
        const newReplies = (post.replies||[]).concat([{authorName:profile.firstName+' '+profile.lastName.charAt(0)+'.', text:val, createdAt:Date.now()}]);
        try{ await db.doc('forum_posts/'+b.dataset.id).update({replies:newReplies}); slot.innerHTML=''; toast('Reply added.'); }catch(err){ toast('Could not reply.'); }
      };
    };
  });
  el.querySelectorAll('.del-post-btn').forEach(b=>{
    b.onclick=async ()=>{
      if(!confirm('Delete this post?')) return;
      try{ await db.doc('forum_posts/'+b.dataset.id).delete(); toast('Post deleted.'); }catch(err){ toast('Could not delete.'); }
    };
  });
}

/* ---- ratings ---- */
let pendingStars=5;
function renderRatings(el){
  const mine = ratings.find(r=>r._id===myId);
  pendingStars = mine? mine.stars : 5;
  const avg = ratings.length? (ratings.reduce((a,r)=>a+r.stars,0)/ratings.length).toFixed(1) : '—';
  el.innerHTML = `
  <div class="page-head"><h1>⭐ Rate JavaCur</h1></div>
  <div class="panel">
    <div style="margin-bottom:16px;"><b style="font-size:1.4rem;">${avg}</b> average from ${ratings.length} rating${ratings.length===1?'':'s'}</div>
    <div class="star-picker" id="starPicker">${[1,2,3,4,5].map(n=>`<span data-n="${n}" class="${n<=pendingStars?'on':''}">★</span>`).join('')}</div>
    <form id="ratingForm">
      <div class="field"><textarea name="comment" placeholder="Optional comment…" rows="2">${mine?esc(mine.comment||''):''}</textarea></div>
      <button class="btn btn-gold" type="submit">${mine?'Update rating':'Submit rating'}</button>
    </form>
  </div>
  <div class="panel" style="margin-top:18px;">
    <h3>What learners are saying</h3>
    ${ratings.length? ratings.slice().sort((a,b)=>b.createdAt-a.createdAt).map(r=>`
      <div class="rating-item">
        <div>${'★'.repeat(r.stars)}${'☆'.repeat(5-r.stars)} <span class="small-note">${esc(r.firstName||'')}</span></div>
        ${r.comment?`<div style="font-size:.9rem; margin-top:4px;">${esc(r.comment)}</div>`:''}
        ${r.adminResponse? `<div class="admin-resp"><b>JavaCur team:</b> ${esc(r.adminResponse)}</div>` : (hasPerm('ratings')? `<div class="reply-form-slot-rating" data-id="${esc(r._id)}" style="margin-top:6px;"><button class="btn btn-sm btn-ghost respond-btn" data-id="${esc(r._id)}">Respond</button></div>`:'')}
      </div>`).join('') : '<div class="empty-state">No ratings yet.</div>'}
  </div>`;
  el.querySelectorAll('#starPicker span').forEach(s=>{
    s.onclick=()=>{ pendingStars=parseInt(s.dataset.n); el.querySelectorAll('#starPicker span').forEach(x=>x.classList.toggle('on', parseInt(x.dataset.n)<=pendingStars)); };
  });
  document.getElementById('ratingForm').onsubmit=async (e)=>{
    e.preventDefault();
    const comment = new FormData(e.target).get('comment').trim();
    try{
      await db.doc('ratings/'+myId).set({stars:pendingStars, comment, firstName:profile.firstName, createdAt: mine?mine.createdAt:Date.now(), adminResponse: mine?mine.adminResponse||null:null});
      toast('Thanks for the feedback!');
    }catch(err){ toast('Could not save your rating.'); }
  };
  el.querySelectorAll('.respond-btn').forEach(b=>{
    b.onclick=()=>{
      const slot = el.querySelector('.reply-form-slot-rating[data-id="'+b.dataset.id+'"]');
      slot.innerHTML = `<form style="display:flex; gap:8px; margin-top:6px;"><input required placeholder="Write a response…" style="flex:1; padding:.5em .7em; border-radius:8px; border:1.5px solid var(--panel-line);"><button class="btn btn-sm btn-purple" type="submit">Send</button></form>`;
      slot.querySelector('form').onsubmit=async (ev)=>{
        ev.preventDefault();
        const val = ev.target.querySelector('input').value.trim();
        try{ await db.doc('ratings/'+b.dataset.id).update({adminResponse:val}); toast('Response saved.'); }catch(err){ toast('Could not save.'); }
      };
    };
  });
}

/* ---- admin ---- */
let adminTab='overview';
function renderAdmin(el){
  const tabs = ['overview','users','content','forum','ratings'];
  el.innerHTML = `
  <div class="page-head"><h1>🛡️ Admin</h1><div class="pill-mode">${ROLE_LABELS[myRole()]}${myRole()==='admin'?(hasPerm('deleteUsers')||hasPerm('unlock')||hasPerm('forum')||hasPerm('ratings')?'':' (no permissions granted yet)'):''}</div></div>
  <div class="admin-tabs">
    ${tabs.map(t=>`<button data-t="${t}" class="${adminTab===t?'active':''}">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('')}
  </div>
  <div id="adminBody"></div>`;
  el.querySelectorAll('.admin-tabs button').forEach(b=>{ b.onclick=()=>{ adminTab=b.dataset.t; renderAdmin(el); }; });
  const body = document.getElementById('adminBody');
  if(adminTab==='overview') return paintAdminOverview(body);
  if(adminTab==='users') return paintAdminUsers(body);
  if(adminTab==='content') return paintAdminContent(body);
  if(adminTab==='forum') return paintAdminForum(body);
  if(adminTab==='ratings') return paintAdminRatings(body);
}
function paintAdminOverview(el){
  const total = directoryDocs.length;
  const online = onlineCount();
  const lockedCount = directoryDocs.filter(d=>d.lockedUntil && d.lockedUntil>Date.now()).length;
  const byDay = {};
  directoryDocs.forEach(d=>{ if(!d.createdAt) return; const day=new Date(d.createdAt).toISOString().slice(0,10); byDay[day]=(byDay[day]||0)+1; });
  const days = Object.keys(byDay).sort().slice(-14);
  const max = Math.max(1,...days.map(d=>byDay[d]));
  const barW = days.length? 100/days.length : 100;
  const bars = days.map((d,i)=>{
    const h = (byDay[d]/max)*120;
    return `<rect x="${i*barW+ (barW*0.15)}%" y="${140-h}" width="${barW*0.7}%" height="${h}" fill="var(--gold-500)" rx="3"></rect>`;
  }).join('');
  el.innerHTML = `
  <div class="stat-row" style="grid-template-columns:repeat(4,1fr); margin-bottom:20px;">
    <div class="stat-box"><div class="num">${total}</div><div class="lbl">Total users</div></div>
    <div class="stat-box"><div class="num">${online}</div><div class="lbl">Online now</div></div>
    <div class="stat-box"><div class="num">${lockedCount}</div><div class="lbl">Locked out</div></div>
    <div class="stat-box"><div class="num">${forumPosts.length}</div><div class="lbl">Forum posts</div></div>
  </div>
  <div class="panel">
    <h3>Signups — last ${days.length||0} active days</h3>
    <svg class="graph-svg" viewBox="0 0 300 150" preserveAspectRatio="none">
      <style>rect{transition:height .3s;}</style>
      ${bars || '<text x="10" y="80" fill="var(--ink-soft)" font-size="10">Not enough data yet</text>'}
    </svg>
    <div class="small-note">Live — updates automatically as people sign up.</div>
  </div>`;
}
const PERM_LABELS = {forum:'Respond/delete forum posts', ratings:'Respond to ratings', deleteUsers:'Remove users from roster', unlock:'Unlock locked-out accounts'};
function paintAdminUsers(el){
  const canSeeUsers = isOwner || hasPerm('deleteUsers') || hasPerm('unlock');
  if(!canSeeUsers){
    el.innerHTML = `<div class="panel"><div class="empty-state"><div class="ic">🔒</div><p>You don't have permission to manage users yet. Ask an owner or super admin to grant you "Remove users" or "Unlock accounts" access.</p></div></div>`;
    return;
  }
  const canManageRoles = myLevel() >= ROLE_LEVELS.superadmin; // owner or super admin
  const options = assignableRoles();
  el.innerHTML = `
  <div class="panel">
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th>${canManageRoles?'<th>Permissions (Admin tier only)</th>':''}<th>Status</th><th>Stars</th><th>Lessons</th><th>Joined</th><th>Last active</th><th></th></tr></thead>
      <tbody>
      ${directoryDocs.slice().sort((a,b)=>ROLE_LEVELS[b.role||'student']-ROLE_LEVELS[a.role||'student'] || (b.lastActive||0)-(a.lastActive||0)).map(d=>{
        const role = d.role||'student';
        const isMe = d._id===myId;
        const manageable = !isMe && canManage(role);
        const locked = d.lockedUntil && d.lockedUntil>Date.now();
        const perms = d.permissions||{};
        return `<tr>
          <td>${esc(d.firstName||'')} ${esc(d.lastName||'')}${isMe?' (you)':''}</td>
          <td>${esc(d.email||'')}</td>
          <td>${canManageRoles && manageable ? `<select class="role-select" data-id="${esc(d._id)}">${options.map(r=>`<option value="${r}" ${r===role?'selected':''}>${ROLE_LABELS[r].replace(/^\S+\s/,'')}</option>`).join('')}</select>` : ROLE_LABELS[role]}</td>
          ${canManageRoles?`<td>${role==='admin' && manageable ? `<div class="checkbox-row" style="flex-direction:column; align-items:flex-start; gap:4px;">${Object.keys(PERM_LABELS).map(p=>`<label class="checkbox-row"><input type="checkbox" class="perm-check" data-id="${esc(d._id)}" data-perm="${p}" ${perms[p]?'checked':''}> ${PERM_LABELS[p]}</label>`).join('')}</div>` : (role==='admin'?'<span class="small-note">has whatever was granted</span>':'<span class="small-note">—</span>')}</td>`:''}
          <td>${locked? '🔒 Locked' : '✅ Active'}</td>
          <td>${d.stars||0}</td><td>${d.completedCount||0}</td><td>${fmtDate(d.createdAt)}</td><td>${d.lastActive?timeAgo(d.lastActive):'—'}</td>
          <td style="white-space:nowrap;">
            ${isMe && locked?`<button class="btn btn-sm btn-purple unlock-user" data-id="${esc(d._id)}">Unlock me</button>`:''}
            ${hasPerm('unlock') && manageable && locked?`<button class="btn btn-sm btn-purple unlock-user" data-id="${esc(d._id)}">Unlock</button>`:''}
            ${hasPerm('deleteUsers') && manageable?`<button class="btn btn-sm btn-danger erase-user" data-id="${esc(d._id)}">Remove</button>`:''}
            ${canManageRoles && manageable?`<button class="btn btn-sm btn-danger delete-user-full" data-id="${esc(d._id)}">Delete completely</button>`:''}
          </td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>
    ${!directoryDocs.length?'<div class="empty-state">No users yet.</div>':''}
    <div class="small-note" style="margin-top:10px;">Role hierarchy: Owner &gt; Super Admin &gt; Admin &gt; User. You can only change the role or permissions of someone ranked below you, and only the owner can create another super admin. Admins hold exactly the privileges checked for them; super admins automatically hold all of them, but — like admins — can never manage other super admins or the owner. "Remove" takes someone off the live roster; "Delete completely" also erases their saved profile and progress and is limited to owners and super admins. Locked accounts unlock automatically after 15 minutes, or sooner with unlock access. Adding courses, lessons, and challenges also requires real "Can edit" access from the Share menu, separate from any app role.</div>
  </div>`;
  el.querySelectorAll('.role-select').forEach(sel=>{
    sel.onchange=async ()=>{
      const newRole = sel.value;
      try{
        const payload = {role:newRole};
        if(newRole!=='admin') payload.permissions = {};
        await db.doc('directory/'+sel.dataset.id).update(payload);
        toast('Role updated to '+ROLE_LABELS[newRole].replace(/^\S+\s/,'')+'.');
      }catch(err){ toast('Could not update this user\'s role.'); }
    };
  });
  el.querySelectorAll('.perm-check').forEach(cb=>{
    cb.onchange=async ()=>{
      try{
        const rec = directoryDocs.find(d=>d._id===cb.dataset.id) || {};
        const perms = {...(rec.permissions||{})};
        perms[cb.dataset.perm] = cb.checked;
        await db.doc('directory/'+cb.dataset.id).update({permissions:perms});
        toast('Permissions updated.');
      }catch(err){ toast('Could not update permissions.'); cb.checked=!cb.checked; }
    };
  });
  el.querySelectorAll('.unlock-user').forEach(b=>{
    b.onclick=async ()=>{
      try{ await db.doc('directory/'+b.dataset.id).update({failedAttempts:0, lockedUntil:null}); toast('Account unlocked.'); }
      catch(err){ toast('Could not unlock this account.'); }
    };
  });
  el.querySelectorAll('.erase-user').forEach(b=>{
    b.onclick=async ()=>{
      if(!confirm('Remove this user from the roster?')) return;
      try{ await db.doc('directory/'+b.dataset.id).delete(); toast('User removed from roster.'); }catch(err){ toast('Could not remove.'); }
    };
  });
  el.querySelectorAll('.delete-user-full').forEach(b=>{
    b.onclick=async ()=>{
      if(!confirm('Permanently delete this user, including their saved profile and progress? This cannot be undone.')) return;
      try{ await db.doc('directory/'+b.dataset.id).delete(); }catch(err){}
      try{ await db.doc('data/users/'+b.dataset.id+'/profile').delete(); toast('User deleted completely.'); }
      catch(err){ toast('Removed from roster, but could not delete their private profile (server error).'); }
    };
  });
}
function paintAdminContent(el){
  if(!canEdit){
    el.innerHTML = `<div class="panel">
      <div class="empty-state">
        <div class="ic">🔒</div>
        <h3>Extra permission needed</h3>
        <p>Adding courses, lessons, and challenges is limited to Admins, Super Admins and the Owner.</p>
      </div>
    </div>`;
    return;
  }
  el.innerHTML = `
  <div class="panel">
    <h3>Add a course</h3>
    <form id="addCourseForm">
      <div class="field-row">
        <div class="field" style="max-width:90px;"><label>Icon</label><input name="icon" placeholder="📘" maxlength="4"></div>
        <div class="field"><label>Title</label><input required name="title"></div>
      </div>
      <div class="field"><label>Description</label><input required name="blurb"></div>
      <button class="btn btn-purple" type="submit">Add course</button>
    </form>
  </div>
  <div class="panel">
    <h3>Add a lesson</h3>
    <form id="addLessonForm">
      <div class="field"><label>Course</label><select name="courseId">${allCourses().map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select></div>
      <div class="field"><label>Term / title</label><input required name="term"></div>
      <div class="field"><label>Read (definition)</label><textarea required name="definition" rows="2"></textarea></div>
      <div class="field"><label>Picture it (analogy)</label><textarea required name="analogy" rows="2"></textarea></div>
      <div class="field"><label>Picture it — explain it like a first grader</label><textarea name="simple" rows="2"></textarea></div>
      <div class="field"><label>See the code (example)</label><textarea name="example" rows="3" class="mono"></textarea></div>
      <div class="field"><label>Why it matters</label><textarea required name="tip" rows="2"></textarea></div>
      <button class="btn btn-purple" type="submit">Add lesson</button>
    </form>
  </div>
  <div class="panel">
    <h3>Add a quiz / challenge question</h3>
    <form id="addQForm">
      <div class="field"><label>Course</label><select name="courseId">${allCourses().map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><select name="type"><option value="mc">Multiple choice</option><option value="code">Code writing</option></select></div>
      <div class="field"><label>Question / prompt</label><textarea required name="prompt" rows="2"></textarea></div>
      <div id="mcFields">
        <div class="field"><label>Option A (correct answer)</label><input name="optA"></div>
        <div class="field"><label>Option B</label><input name="optB"></div>
        <div class="field"><label>Option C</label><input name="optC"></div>
        <div class="field"><label>Option D</label><input name="optD"></div>
      </div>
      <div class="field"><label>Explanation / model answer</label><textarea name="explanation" rows="2"></textarea></div>
      <div class="field"><label>Keywords for code check (comma-separated, code type only)</label><input name="keywords" placeholder="class dog, void bark"></div>
      <button class="btn btn-purple" type="submit">Add question</button>
    </form>
  </div>
  <div class="panel">
    <h3>Custom content so far</h3>
    <p class="small-note">${customCourses.length} course(s), ${customLessons.length} lesson(s), ${customQuestions.length} question(s) added.</p>
  </div>`;
  document.getElementById('addCourseForm').onsubmit=async (e)=>{
    e.preventDefault(); const f=new FormData(e.target);
    try{ await db.collection('custom_courses').add({title:f.get('title'), icon:f.get('icon')||'📘', blurb:f.get('blurb'), createdAt:Date.now()}); toast('Course added.'); e.target.reset(); }catch(err){ toast('Could not add course.'); }
  };
  document.getElementById('addLessonForm').onsubmit=async (e)=>{
    e.preventDefault(); const f=new FormData(e.target);
    try{ await db.collection('custom_lessons').add({courseId:f.get('courseId'), term:f.get('term'), definition:f.get('definition'), analogy:f.get('analogy'), simple:f.get('simple')||'', example:f.get('example')||'', tip:f.get('tip'), createdAt:Date.now()}); toast('Lesson added.'); e.target.reset(); }catch(err){ toast('Could not add lesson.'); }
  };
  document.getElementById('addQForm').onsubmit=async (e)=>{
    e.preventDefault(); const f=new FormData(e.target);
    const type=f.get('type');
    const payload={courseId:f.get('courseId'), type, prompt:f.get('prompt'), explanation:f.get('explanation')||'', createdAt:Date.now()};
    if(type==='mc'){
      payload.options=[f.get('optA'),f.get('optB'),f.get('optC'),f.get('optD')].filter(Boolean);
      payload.correctIndex=0;
    } else {
      payload.keywords=(f.get('keywords')||'').split(',').map(s=>s.trim()).filter(Boolean);
    }
    try{ await db.collection('custom_questions').add(payload); toast('Question added.'); e.target.reset(); }catch(err){ toast('Could not add question.'); }
  };
}
function paintAdminForum(el){
  el.innerHTML = `<div class="panel">${forumPosts.length? forumPosts.map(p=>forumPostHtml(p)).join(''): '<div class="empty-state">No posts yet.</div>'}</div>`;
  wireForumActions(el);
}
function paintAdminRatings(el){ renderRatings(el); }

/* ============================= INIT ============================= */
boot();

window.addEventListener('resize', ()=>{});
})();
