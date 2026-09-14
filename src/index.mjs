import webpush from 'web-push';

// YUKI_PRIVATE_CLOUD_PROACTIVE_PARITY_V2_20260906
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const META = '__private_cloud_meta_v1__';
const INITIAL_SCHEMA = 'CREATE TABLE IF NOT EXISTS private_cloud_state (device_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT \'{}\', updated_at INTEGER NOT NULL);';
const clean = (value, limit = 0) => { const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim(); return limit ? text.slice(0, limit) : text; };
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; } };
const clamp = (value, min, max, fallback = min) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'access-control-allow-origin':'*', 'access-control-allow-headers':'content-type', 'access-control-allow-methods':'GET, POST, OPTIONS' } });

async function hash(value) { const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || ''))); return [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function validDevice(input = {}) { const id = clean(input.id, 96), secret = clean(input.secret, 160); if (!id || !secret) throw new Error('设备凭据无效'); return { id, secret }; }
function validApi(raw = {}) { const api = { url:clean(raw.url,1200), key:clean(raw.key,4096), model:clean(raw.model,240), provider:clean(raw.provider,48), temp:Number(raw.temp) || .8 }; if (!/^https:\/\//i.test(api.url) || !api.key || !api.model) throw new Error('当前文字 API 配置不完整'); return api; }
async function readRow(db, id) { return db.prepare('SELECT * FROM private_cloud_state WHERE device_id=?').bind(id).first(); }
async function writeRow(db, id, secretHash, state) { await db.prepare('INSERT INTO private_cloud_state(device_id,secret_hash,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET secret_hash=excluded.secret_hash,state_json=excluded.state_json,updated_at=excluded.updated_at').bind(id, secretHash, JSON.stringify(state), Date.now()).run(); }
async function ensureSchema(db) { await db.exec(INITIAL_SCHEMA); }
async function meta(db) { const row = await readRow(db, META), state = parse(row?.state_json); if (state?.vapid?.publicKey && state?.vapid?.privateKey) return state; const keys = webpush.generateVAPIDKeys(); const next = { vapid:keys, lastRunAt:0 }; await writeRow(db, META, 'internal', next); return next; }
async function own(db, input) { const device = validDevice(input), row = await readRow(db, device.id); if (!row || row.device_id === META) throw new Error('设备尚未注册'); if (row.secret_hash !== await hash(device.secret)) throw new Error('设备凭据不匹配'); return { device, state:parse(row.state_json) }; }
function action(request) { const url = new URL(request.url); return clean(url.pathname.split('/').filter(Boolean).pop() || 'config', 32); }
async function body(request) { if (request.method === 'GET') return {}; const value = await request.json().catch(() => ({})); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效'); return value; }
function apiRoot(url) { return String(url).replace(/\/+$/, '').replace(/\/(v1\/chat\/completions|v4\/chat\/completions|api\/v3\/chat\/completions|chat\/completions|v1|v4|api\/v3)$/i, ''); }
async function complete(api, prompt) {
  const root = apiRoot(api.url), provider = api.provider === 'anthropic' || root.includes('anthropic.com') ? 'anthropic' : api.provider === 'gemini' || root.includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai';
  let response;
  if (provider === 'anthropic') response = await fetch(`${root}/v1/messages`, { method:'POST', headers:{'x-api-key':api.key,'anthropic-version':'2023-06-01','content-type':'application/json'}, body:JSON.stringify({model:api.model,max_tokens:600,temperature:api.temp,messages:[{role:'user',content:prompt}]}) });
  else if (provider === 'gemini') response = await fetch(`${root.replace(/\/v1beta$/i,'')}/v1beta/models/${encodeURIComponent(api.model)}:generateContent?key=${encodeURIComponent(api.key)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:api.temp,maxOutputTokens:600}}) });
  else { const suffix = root.includes('open.bigmodel.cn') ? '/v4/chat/completions' : root.includes('volces.com') ? '/api/v3/chat/completions' : '/v1/chat/completions'; response = await fetch(`${root}${suffix}`, { method:'POST',headers:{authorization:`Bearer ${api.key}`,'content-type':'application/json'},body:JSON.stringify({model:api.model,temperature:api.temp,messages:[{role:'user',content:prompt}]}) }); }
  if (!response.ok) throw new Error(`文字 API HTTP ${response.status}`);
  const data = await response.json();
  return clean(provider === 'anthropic' ? (data.content || []).map(item => item?.text || '').join('') : provider === 'gemini' ? (data.candidates?.[0]?.content?.parts || []).map(item => item?.text || '').join('') : data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '', 1400);
}

function localClock(now, offsetMinutes = 0) {
  const shifted = new Date(now - Number(offsetMinutes || 0) * MINUTE);
  const y = shifted.getUTCFullYear(), m = String(shifted.getUTCMonth()+1).padStart(2,'0'), d = String(shifted.getUTCDate()).padStart(2,'0');
  return { date:`${y}-${m}-${d}`, minutes:shifted.getUTCHours()*60+shifted.getUTCMinutes() };
}
function timeMinutes(value = '') { const m = String(value).match(/^(\d{2}):(\d{2})$/); return m ? clamp(Number(m[1]),0,23,0)*60+clamp(Number(m[2]),0,59,0) : null; }
function inQuietHours(settings, now, offset) {
  if (settings.quietEnabled === false) return false;
  const start = timeMinutes(settings.quietStart || '23:00'), end = timeMinutes(settings.quietEnd || '08:00');
  if (start == null || end == null || start === end) return false;
  const current = localClock(now, offset).minutes;
  return start < end ? current >= start && current < end : current >= start || current < end;
}
function quietEndAt(settings, now, offset) { const end = timeMinutes(settings.quietEnd || '08:00'); if (end == null) return now + HOUR; const clock = localClock(now, offset), delta = (end - clock.minutes + 1440) % 1440; return now + Math.max(10, delta) * MINUTE; }
function localDateTimeEpoch(date, time, offsetMinutes = 0) {
  const dm = String(date||'').match(/^(\d{4})-(\d{2})-(\d{2})$/), tm = String(time||'').match(/^(\d{2}):(\d{2})$/); if (!dm || !tm) return 0;
  return Date.UTC(Number(dm[1]), Number(dm[2])-1, Number(dm[3]), Number(tm[1]), Number(tm[2])) + Number(offsetMinutes||0)*MINUTE;
}
function currentRoleBusy(snapshot, now) {
  const rows = Array.isArray(snapshot.roleScheduleItems) ? snapshot.roleScheduleItems : [], offset = snapshot.timezoneOffsetMinutes || 0, clock = localClock(now, offset);
  for (const item of rows) {
    if (String(item?.date || '') !== clock.date || !/^\d{2}:\d{2}$/.test(String(item?.start || ''))) continue;
    const start = timeMinutes(item.start), end = timeMinutes(item.end || '') ?? Math.min(1439, start + 90);
    if (clock.minutes >= start && clock.minutes <= end) return { busy:true, title:clean(item.title,80), deferMinutes:Math.max(10, end-clock.minutes+10) };
  }
  return { busy:false, title:'', deferMinutes:0 };
}
function importantSchedule(title = '', note = '') { return /(考试|面试|答辩|比赛|工作|开会|会议|上课|课程|出差|值班|加班|演出|拍摄|就医|复诊|复查|体检|医院|看病|手术|报告|签约|入职|离职|航班|火车|出发|返程|旅行|生日|截止|交作业|搬家|约会|重要|结果)/.test(`${title} ${note}`); }
function scheduleCandidates(snapshot, now) {
  if (snapshot.settings?.scheduleCare === false) return [];
  const rows = Array.isArray(snapshot.roleScheduleItems) ? snapshot.roleScheduleItems : [], offset = snapshot.timezoneOffsetMinutes || 0, out = [];
  for (const item of rows) {
    if (['cancelled','superseded','changed'].includes(String(item?.status||''))) continue;
    const title = clean(item?.title,100), note = clean(item?.note,220), when = localDateTimeEpoch(item?.date, item?.start || item?.time, offset); if (!title || !when) continue;
    const delta = when-now, id = clean(item?.id || `${item?.date}:${item?.start}:${title}`,120);
    if (String(item?.kind||'') === 'joint_commitment' && Number(item?.contactedAt||0) <= 0 && delta <= 0 && delta >= -2*HOUR) {
      out.push({type:'joint_commitment_due',reason:`你和用户确认的「${title}」现在到了约定时间。`,reasonKey:`joint-commitment:${id}:${when}:due`,priority:130,bypass:true,explicit:true,context:`已确认约定：${item?.date||''} ${item?.start||''} ${title}`,expiryAt:when+2*HOUR,appointmentId:id,personaId:clean(item?.personaId||snapshot.personaId,120)}); continue;
    }
    if (String(item?.kind||'') === 'joint_commitment' || !importantSchedule(title,note)) continue;
    if (delta >= 15*MINUTE && delta <= 2*HOUR) out.push({type:'schedule_upcoming',reason:`角色近期行程里的「${title}」将在不久后开始。`,reasonKey:`schedule:${id}:${when}:before`,priority:90,bypass:true,context:note||title,expiryAt:when+30*MINUTE});
    else if (delta <= -15*MINUTE && delta >= -60*MINUTE) out.push({type:'schedule_followup',reason:`角色计划中的「${title}」时间已经过去；只有结合上下文确实适合时，才自然问一句后来怎么样，不能把 soft plan 当成已发生事实。`,reasonKey:`schedule:${id}:${when}:after`,priority:86,bypass:true,context:note||title,expiryAt:when+60*MINUTE});
  }
  return out;
}
function brainFollowup(snapshot, now) {
  if (snapshot.settings?.eventFollowup === false) return null;
  const rows = Array.isArray(snapshot.brainFollowups) ? snapshot.brainFollowups : [];
  const row = rows.filter(item=>Number(item?.dueAt||0)<=now && Number(item?.expiresAt||now+1)>=now).sort((a,b)=>Number(a.dueAt)-Number(b.dueAt))[0];
  return row ? {type:'brain_followup',reason:clean(row.reason||row.summary,420),reasonKey:`brain:${clean(row.id,160)}:${Number(row.dueAt)||0}`,priority:96,bypass:true,context:clean(row.summary||row.reason,500),expiryAt:Number(row.expiresAt)||now+2*DAY,jobId:clean(row.id,180)} : null;
}
function conversationContinue(snapshot, now) {
  if (snapshot.settings?.conversationContinue === false) return null;
  const recent = Array.isArray(snapshot.recentMessages) ? snapshot.recentMessages : [], last = recent[recent.length-1], user = [...recent].reverse().find(m=>m.role==='user');
  if (!last || last.role !== 'assistant' || last.proactive === true || !user) return null;
  const age = now-Number(last.timestamp||0); if (age < 2*HOUR || age > 18*HOUR) return null;
  return {type:'conversation_continue',reason:`最近一次私聊里用户提到“${clean(user.text,160)}”。只有现在确实想起与这件事有关的新内容时才联系，没有新角度就取消。`,reasonKey:`conversation:${clean(user.id||user.timestamp||user.text,120)}`,priority:64,bypass:false,context:`用户：${clean(user.text,220)}\n角色：${clean(last.text,220)}`};
}
function absenceIntent(entry, snapshot, now) {
  const settings = snapshot.settings || {}; if (settings.absenceEnabled === false) return null;
  const strength = ['restrained','natural','casual'].includes(settings.strength) ? settings.strength : 'natural', base = Number(settings.absenceMinHours)||({restrained:18,natural:8,casual:4}[strength]);
  const last = Number(snapshot.lastUserActivityAt||0); if (!last || now-last < base*HOUR) return null;
  const anchor = Number(entry.absenceAnchorAt||0), stage = anchor === last ? clamp(entry.absenceStage,0,2,0) : 0;
  if (stage >= 2) return null;
  if (stage === 1) { if (strength === 'restrained') return null; const wait=Math.max(12,base)*HOUR; if (!entry.absenceLastAt || now-Number(entry.absenceLastAt)<wait) return null; return {type:'absence_checkin',reason:'用户在上一次轻微的主动询问后仍没有出现。只有角色性格和关系真的会自然再确认一次时才发；最多这一次，之后必须停止追问。',reasonKey:`absence:${snapshot.charId}:stage2:${last}`,priority:68,bypass:false,context:`玩家已经约 ${Math.floor((now-last)/HOUR)} 小时没有互动。这是第二阶段，也是本轮 absence 链最后一次机会。`,absenceStage:2,absenceAnchorAt:last}; }
  return {type:'absence_checkin',reason:'玩家已经一段时间没有出现。如果符合人物性格与当前关系，可以自然表现好奇、想念、担心、轻微抱怨或调侃；也可以完全不提失联而从角色自己的生活开口。',reasonKey:`absence:${snapshot.charId}:stage1:${last}`,priority:60,bypass:false,context:`玩家已经约 ${Math.floor((now-last)/HOUR)} 小时没有互动。不要机械说“你怎么不理我”。`,absenceStage:1,absenceAnchorAt:last};
}
function scheduledJobCandidate(entry, now) {
  const terminal = entry.terminalJobs && typeof entry.terminalJobs === 'object' ? entry.terminalJobs : {}, rows = Array.isArray(entry.jobs) ? entry.jobs : [];
  const due = rows.filter(j=>!terminal[String(j?.id||'')] && Number(j?.dueAt||0)<=now && Number(j?.expiresAt||Number(j?.dueAt||0)+2*HOUR)>=now).sort((a,b)=>Number(a.dueAt)-Number(b.dueAt))[0];
  return due ? {type:'scheduled_proactive_contact',reason:clean(due.reason||'用户明确安排了一次主动联系',420),reasonKey:`scheduled:${clean(due.id,180)}`,priority:140,bypass:true,explicit:true,context:'这是用户明确安排的一次性主动联系；到期后只发送一次。',expiryAt:Number(due.expiresAt)||Number(due.dueAt)+2*HOUR,jobId:clean(due.id,180)} : null;
}
function normalizeIntentState(entry) { return entry.intentState && typeof entry.intentState === 'object' ? {...entry.intentState} : {}; }
function intentAllowed(entry, intent, settings, now) {
  if (!intent || intent.expiryAt && now > intent.expiryAt) return false;
  const state = normalizeIntentState(entry)[intent.reasonKey];
  if (state?.lastSentAt && !intent.explicit) return false;
  if (Number(state?.nextEligibleAt||0)>now) return false;
  const minHours=Math.max(1,Number(settings.minIntervalHours)||8);
  if (!intent.bypass && Number(entry.lastSentAt||0)>0 && now-Number(entry.lastSentAt)<minHours*HOUR) return false;
  return true;
}
function chooseIntent(entry, snapshot, settings, now) {
  const explicit=scheduledJobCandidate(entry,now); if (intentAllowed(entry,explicit,settings,now)) return explicit;
  const latest=Number(snapshot.lastUserActivityAt||0); if (latest && now-latest>=0 && now-latest<20*MINUTE) return null;
  const candidates=[...scheduleCandidates(snapshot,now),brainFollowup(snapshot,now),conversationContinue(snapshot,now),absenceIntent(entry,snapshot,now)].filter(Boolean).sort((a,b)=>b.priority-a.priority);
  return candidates.find(item=>intentAllowed(entry,item,settings,now))||null;
}
function markIntent(entry, intent, patch = {}) { const map=normalizeIntentState(entry); map[intent.reasonKey]={...(map[intent.reasonKey]||{}),...patch,updatedAt:Date.now()}; const keep=Object.entries(map).sort((a,b)=>Number(b[1]?.updatedAt||0)-Number(a[1]?.updatedAt||0)).slice(0,80); return {...entry,intentState:Object.fromEntries(keep)}; }
function addJobReceipt(state, entry, jobId, status, messageId='') {
  const id=clean(jobId,180); if(!id)return {state,entry}; const receipts=Array.isArray(state.jobReceipts)?state.jobReceipts.filter(r=>String(r?.id)!==id):[]; receipts.unshift({id,status:status==='cancelled'?'cancelled':'done',messageId:clean(messageId,160),updatedAt:Date.now()});
  const terminal={...(entry.terminalJobs||{}),[id]:status==='cancelled'?'cancelled':'done'}; return {state:{...state,jobReceipts:receipts.slice(0,120)},entry:{...entry,terminalJobs:terminal,jobs:(Array.isArray(entry.jobs)?entry.jobs:[]).filter(j=>String(j?.id||'')!==id)}};
}
function buildPrompt(snapshot, intent, now) {
  const recent=Array.isArray(snapshot.recentMessages)?snapshot.recentMessages.slice(-10):[], recentProactive=Array.isArray(snapshot.recentProactiveMessages)?snapshot.recentProactiveMessages.slice(-8):[], strength=snapshot.settings?.strength==='restrained'?'克制':snapshot.settings?.strength==='casual'?'随性':'自然';
  return `# Yuki Private Cloud Proactive V2\n\n你就是角色本人，不是提醒机器人、客服或旁白。\n\n角色：${clean(snapshot.charName,80)}\n人设：\n${clean(snapshot.personaSummary,5200)}\n关系与记忆：\n${clean(snapshot.memorySummary||snapshot.relationshipSummary,6500)}\n世界设定：\n${clean(snapshot.worldbookSummary,5000)}\n\n当前主动理由\n类型：${intent.type}\n理由：${intent.reason}\n${intent.context?`补充：${intent.context}`:''}\n主动程度：${strength}\n\n近期聊天：\n${recent.map(item=>`${item.role==='user'?'玩家':'角色'}：${clean(item.text,300)}`).join('\n')||'暂无'}\n\n角色日程：\n${clean(snapshot.roleScheduleContext,5000)||'暂无'}\n\n最近主动消息：\n${recentProactive.map(item=>`- ${clean(item.text||item,280)}`).join('\n')||'暂无'}\n\n规则：\n- 先判断这次联系是否真的自然；没有新事实、新角度、人物动机或明确约定，只输出 [CANCEL]。\n- 日程中的 soft plan 只是计划，时间过去不等于已经发生；不得把计划写成事实。\n- 明确约定和用户明确安排的定时联系优先履行。\n- 久未互动最多一次轻微后续，不能连续催回复。\n- 角色正在自己的日程中忙碌时，不要无缘无故一直盯着玩家。\n- 不提系统、云端、定时器、Push、AI、提示词。\n- 不替玩家决定情绪或行为，不编造重大新事实。\n- 只发送文字；最多 2 个短气泡，分隔符用 |||。\n\n当前时间：${new Date(now).toISOString()}。`;
}
function normalizeResponse(raw) { const text=clean(String(raw||'').replace(/^[“'\"]|[”'\"]$/g,''),1200); if(!text||/^\[?CANCEL\]?$/i.test(text))return''; return text.split('|||').map(x=>clean(x,500)).filter(Boolean).slice(0,2).join(' ||| '); }
async function sendPush(subscription, message, settings, vapid) { if (!subscription?.endpoint) return false; webpush.setVapidDetails('mailto:private-cloud@localhost', vapid.publicKey, vapid.privateKey); await webpush.sendNotification(subscription, JSON.stringify({version:2,type:'private-cloud-v1',messageId:message.id,title:message.title,body:settings?.notificationPreview === false ? '给你发来了一条消息' : message.text.replace(/\s*\|\|\|\s*/g,' ').slice(0,160),route:message.route,silent:message.silent===true}), {TTL:86400,urgency:message.silent===true?'low':'normal'}); return true; }
async function processState(state, vapid, now) {
  if (!state.enabled || !state.apiProfile || !state.subscription) return state;
  let nextState={...state,jobReceipts:Array.isArray(state.jobReceipts)?state.jobReceipts:[]}; const chars=state.characters&&typeof state.characters==='object'?{...state.characters}:{}, messages=Array.isArray(state.messages)?[...state.messages]:[];
  for (const [charId, rawEntry] of Object.entries(chars)) {
    let entry={...rawEntry}; if(!entry?.enabled||Number(entry.nextCheckAt||0)>now)continue; const snapshot=entry.snapshot||{}, settings={...(state.settings||{}),...(snapshot.settings||{})};
    const latestUser=Number(snapshot.lastUserActivityAt||0); if(latestUser && latestUser!==Number(entry.absenceAnchorAt||0) && latestUser>Number(entry.absenceAnchorAt||0)) entry={...entry,absenceStage:0,absenceLastAt:0,absenceAnchorAt:latestUser};
    // Locally cancelled scheduled jobs disappear from the next snapshot; replacement is authoritative.
    const expiredJobs=(Array.isArray(entry.jobs)?entry.jobs:[]).filter(j=>Number(j?.expiresAt||0)>0&&Number(j.expiresAt)<now&&!entry.terminalJobs?.[String(j?.id||'')]);
    for(const job of expiredJobs){const r=addJobReceipt(nextState,entry,job.id,'cancelled');nextState=r.state;entry=r.entry;}
    const quiet=inQuietHours(settings,now,snapshot.timezoneOffsetMinutes||0); if(quiet&&settings.quietMode==='delay'){entry.nextCheckAt=quietEndAt(settings,now,snapshot.timezoneOffsetMinutes||0);chars[charId]=entry;continue;}
    const intent=chooseIntent(entry,snapshot,settings,now); if(!intent){entry.nextCheckAt=now+30*MINUTE;chars[charId]=entry;continue;}
    const busy=currentRoleBusy(snapshot,now); if(busy.busy&&!intent.explicit&&intent.type!=='schedule_upcoming'){entry.nextCheckAt=now+busy.deferMinutes*MINUTE;chars[charId]=entry;continue;}
    let text=''; try{text=normalizeResponse(await complete(state.apiProfile,buildPrompt(snapshot,intent,now)));}catch(_){entry=markIntent(entry,intent,{nextEligibleAt:now+2*HOUR});entry.nextCheckAt=now+2*HOUR;chars[charId]=entry;continue;}
    if(!text){entry=markIntent(entry,intent,{nextEligibleAt:now+6*HOUR});if(intent.jobId){const r=addJobReceipt(nextState,entry,intent.jobId,'cancelled');nextState=r.state;entry=r.entry;}entry.nextCheckAt=now+Math.min(6,Math.max(1,Number(settings.minIntervalHours)||8))*HOUR;chars[charId]=entry;continue;}
    const message={id:`pc_${crypto.randomUUID()}`,charId:String(charId),title:clean(snapshot.charName||'角色',80),text,route:`/?route=conversation&charId=${encodeURIComponent(String(charId))}`,createdAt:now,acknowledged:false,intentType:intent.type,reasonKey:intent.reasonKey,jobId:clean(intent.jobId,180),appointmentId:clean(intent.appointmentId,160),personaId:clean(intent.personaId||snapshot.personaId,120),silent:quiet&&settings.quietMode!=='delay'};
    messages.unshift(message); await sendPush(state.subscription,message,settings,vapid).catch(()=>false); entry=markIntent(entry,intent,{lastSentAt:now,nextEligibleAt:0}); entry.lastSentAt=now;
    if(intent.type==='absence_checkin'){entry.absenceStage=Number(intent.absenceStage)||1;entry.absenceLastAt=now;entry.absenceAnchorAt=Number(intent.absenceAnchorAt||latestUser)||latestUser;}
    if(intent.jobId){const r=addJobReceipt(nextState,entry,intent.jobId,'done',message.id);nextState=r.state;entry=r.entry;}
    entry.nextCheckAt=now+Math.max(30,Math.max(1,Number(settings.minIntervalHours)||8)*60)*MINUTE; chars[charId]=entry;
  }
  return {...nextState,characters:chars,messages:messages.slice(0,80),jobReceipts:(nextState.jobReceipts||[]).slice(0,120),updatedAt:now};
}
async function run(db) { await ensureSchema(db); const current = await meta(db), now = Date.now(); if (now - Number(current.lastRunAt || 0) < 45_000) return {ok:true,skipped:true}; await writeRow(db, META, 'internal', {...current,lastRunAt:now}); const {results} = await db.prepare('SELECT * FROM private_cloud_state WHERE device_id != ? LIMIT 100').bind(META).all(); for (const row of results || []) await writeRow(db, row.device_id, row.secret_hash, await processState(parse(row.state_json), current.vapid, now)); return {ok:true,processed:(results || []).length}; }
function buildTestMessage(state, now) {
  if (!state.subscription?.endpoint) throw new Error('后台消息尚未连接，请先开启后台消息');
  const selected = Object.entries(state.characters || {}).find(([, entry]) => entry?.snapshot);
  if (!selected) throw new Error('请先同步至少一个角色');
  const [charId, entry] = selected, snapshot = entry.snapshot || {};
  return {id:`pc_test_${crypto.randomUUID()}`,charId:String(charId),title:clean(snapshot.charName||'角色',80),text:'这是一条云端测试消息：如果你能看到它，说明私有云端已经可以联系当前设备。',route:`/?route=conversation&charId=${encodeURIComponent(String(charId))}`,createdAt:now,acknowledged:false,intentType:'cloud_test',reasonKey:'cloud-test:manual',jobId:'',appointmentId:'',personaId:clean(snapshot.personaId,120),silent:false};
}

export default {
  async scheduled(_, env, ctx) { ctx.waitUntil(run(env.PRIVATE_CLOUD_DB)); },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ok:true});
    try {
      const currentAction = action(request), data = await body(request), db = env.PRIVATE_CLOUD_DB;
      if (!db) throw new Error('私有数据库尚未连接'); await ensureSchema(db);
      if (currentAction === 'config') { const current=await meta(db); return json({ok:true,configured:true,privateCloudV1:true,privateCloudParityV2:true,candidateContractV2:true,vapidPublicKey:current.vapid.publicKey,version:2}); }
      if (currentAction === 'run') return json({ok:false,error:'该操作仅由定时任务执行'},403);
      if (currentAction === 'enable') { const device=validDevice(data.device),existing=await readRow(db,device.id),secretHash=await hash(device.secret); if(existing?.secret_hash&&existing.secret_hash!==secretHash)throw new Error('设备凭据不匹配'); const old=parse(existing?.state_json); await writeRow(db,device.id,secretHash,{...old,enabled:true,apiProfile:validApi(data.apiProfile),settings:data.settings||{},subscription:data.pushSubscription||null,characters:old.characters||{},messages:old.messages||[],jobReceipts:old.jobReceipts||[]}); return json({ok:true,enabled:true,version:2}); }
      const current=await own(db,data.device);
      if (currentAction === 'test') { const now=Date.now(), message=buildTestMessage(current.state,now), nextState={...current.state,messages:[message,...(current.state.messages||[])].slice(0,80),updatedAt:now}; await writeRow(db,current.device.id,await hash(current.device.secret),nextState); let pushSent=false; try { pushSent=await sendPush(current.state.subscription,message,current.state.settings||{},(await meta(db)).vapid); } catch (_) {} return json({ok:true,test:true,pushSent,messageId:message.id}); }
      if (currentAction === 'settings') { await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,settings:data.settings||{},enabled:data.enabled===true,apiProfile:data.apiProfile?validApi(data.apiProfile):current.state.apiProfile}); return json({ok:true}); }
      if (currentAction === 'snapshot') { const id=clean(data.charId,120); if(!id)throw new Error('角色无效'); const chars={...(current.state.characters||{})}, old={...(chars[id]||{})}, terminal=old.terminalJobs&&typeof old.terminalJobs==='object'?old.terminalJobs:{}; const jobs=(Array.isArray(data.jobs)?data.jobs:[]).filter(j=>j?.id&&!terminal[String(j.id)]).slice(0,48); chars[id]={...old,enabled:data.enabled!==false,snapshot:data.snapshot||{},jobs,nextCheckAt:data.expedite===true?Date.now()+5_000:Number(data.nextCheckAt)||Date.now()+MINUTE,lastSentAt:Number(old.lastSentAt||0),terminalJobs:terminal}; await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,characters:chars}); return json({ok:true,candidateContractV2:true}); }
      if (currentAction === 'reconcile') return json({ok:true,messages:(current.state.messages||[]).filter(item=>!item.acknowledged).map(item=>({message_id:item.id,char_id:item.charId,text:item.text,created_at:item.createdAt,intent_type:item.intentType||'absence_checkin',reason_key:item.reasonKey||'',job_id:item.jobId||'',appointment_id:item.appointmentId||'',persona_id:item.personaId||''})),jobReceipts:Array.isArray(current.state.jobReceipts)?current.state.jobReceipts:[]});
      if (currentAction === 'ack') { const ids=new Set(Array.isArray(data.messageIds)?data.messageIds.map(String):[]); await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,messages:(current.state.messages||[]).map(item=>ids.has(String(item.id))?{...item,acknowledged:true}:item)}); return json({ok:true,count:ids.size}); }
      if (currentAction === 'disable') { if(data.purge===true)await db.prepare('DELETE FROM private_cloud_state WHERE device_id=?').bind(current.device.id).run(); else await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,enabled:false,subscription:null,apiProfile:null}); return json({ok:true}); }
      return json({ok:false,error:'未知操作'},404);
    } catch (error) { return json({ok:false,error:clean(error?.message||error,180)||'私有云端暂时不可用'},400); }
  }
};


