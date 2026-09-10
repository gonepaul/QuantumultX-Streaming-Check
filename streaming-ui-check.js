/***
 * Quantumult X 流媒体 / AI 解锁检测（Modern Edition）
 * Updated: 2026-09-10
 *
 * 参考实现：
 * - https://github.com/HsukqiLee/MediaUnlockTest
 * - https://github.com/lmc999/RegionRestrictionCheck
 *
 * 设计原则：所有任务均等待、只调用一次 $done、未知不冒充“不支持”、
 * 区分可用/受限/被封/接口异常，并尽量返回地区。
 *
 * Quantumult X 598+：
 * event-interaction <SCRIPT_URL>, tag=流媒体与AI解锁检测, img-url=checkmark.seal.system, enabled=true
 ***/

const POLICY = typeof $environment !== "undefined" ? $environment.params : "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const TIMEOUT = 9000;
const ARROW = " ➟ ";
const DISNEY_KEY = "ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84";

const S = Object.freeze({ OK:"ok", LIMITED:"limited", NO:"no", BANNED:"banned", ERROR:"error", TIMEOUT:"timeout", UNKNOWN:"unknown" });

function statusCode(r) { return Number(r && (r.statusCode || r.status)) || 0; }
function header(r, name) {
  const h = (r && r.headers) || {};
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(h[key]) : "";
}
function safeJSON(s) { try { return JSON.parse(s); } catch (_) { return null; } }
function countryFlag(code) {
  code = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...code.split("").map(c => 127397 + c.charCodeAt(0)));
}
function result(name, status, region, detail) { return { name, status, region: region || "", detail: detail || "" }; }
function errResult(name, e) {
  const text = String(e && (e.message || e) || "未知异常");
  return result(name, /timeout|timed out/i.test(text) ? S.TIMEOUT : S.ERROR, "", text.slice(0, 80));
}

function request(o, ms = TIMEOUT) {
  const option = Object.assign({}, o);
  option.headers = Object.assign({ "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, o.headers || {});
  option.timeout = option.timeout || ms;
  option.opts = Object.assign({ policy: POLICY }, o.opts || {});
  return Promise.race([
    $task.fetch(option),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms + 600))
  ]);
}
const get = (url, extra = {}) => request(Object.assign({ url, method:"GET" }, extra));
const postJSON = (url, body, headers = {}) => request({ url, method:"POST", headers:Object.assign({"Content-Type":"application/json"}, headers), body });
const postForm = (url, body, headers = {}) => request({ url, method:"POST", headers:Object.assign({"Content-Type":"application/x-www-form-urlencoded"}, headers), body });

async function cloudflareLoc(host) {
  const r = await get("https://" + host + "/cdn-cgi/trace", { opts:{ redirection:false } });
  const m = String(r.body || "").match(/^loc=([^\r\n]+)/m);
  return m ? m[1].toUpperCase() : "";
}

async function checkNetflix() {
  const name = "Netflix";
  try {
    const [a,b] = await Promise.all([
      get("https://www.netflix.com/title/81280792", { opts:{redirection:false} }),
      get("https://www.netflix.com/title/70143836", { opts:{redirection:false} })
    ]);
    const codes = [statusCode(a), statusCode(b)];
    if (codes.every(x => x === 403)) return result(name,S.BANNED,"","IP 被 Netflix 拒绝");
    if (codes.every(x => x === 404)) return result(name,S.LIMITED,"","仅自制内容");
    if (codes.some(x => x === 200 || x === 301 || x === 302)) {
      let loc = header(a,"location") || header(a,"x-originating-url") || header(b,"location") || header(b,"x-originating-url");
      let m = loc.match(/netflix\.com\/(?:([a-z]{2})(?:-[a-z]{2})?\/)?title/i);
      return result(name,S.OK,m && m[1] ? m[1] : "","完整目录探测通过");
    }
    return result(name,S.UNKNOWN,"","HTTP " + codes.join("/"));
  } catch(e) { return errResult(name,e); }
}

async function checkYouTube() {
  const name = "YouTube Premium";
  try {
    const r = await get("https://www.youtube.com/premium", { headers:{Cookie:"CONSENT=YES+cb.20220301-11-p0.en+FX+700; SOCS=CAISOAgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTIxLjA3X3AxGgV6aC1DTiACGgYIgNTEsgY"} });
    const body = String(r.body || "");
    if (body.includes("www.google.cn")) return result(name,S.NO,"CN","中国区不可用");
    if (/Premium is not available in your country/i.test(body)) return result(name,S.NO,"","地区不可用");
    const m = body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/);
    if (m) return result(name,S.OK,m[1],"购买页可用");
    if (/premiumPurchaseButton|manageSubscriptionButton|\/month|\/月/.test(body)) return result(name,S.OK,"","购买页可用，地区未知");
    return result(name,S.UNKNOWN,"","页面结构无法识别");
  } catch(e) { return errResult(name,e); }
}

async function checkDisney() {
  const name = "Disney+";
  try {
    const d = await postJSON("https://disney.api.edge.bamgrid.com/devices", JSON.stringify({deviceFamily:"browser",applicationRuntime:"chrome",deviceProfile:"windows",attributes:{}}), {authorization:"Bearer " + DISNEY_KEY});
    if (statusCode(d) === 403 || /403 ERROR/.test(d.body || "")) return result(name,S.BANNED,"","Disney 拒绝此 IP");
    const assertion = (safeJSON(d.body || "") || {}).assertion;
    if (!assertion) return result(name,S.ERROR,"","设备令牌格式异常");
    const form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&latitude=0&longitude=0&platform=browser&subject_token=" + encodeURIComponent(assertion) + "&subject_token_type=urn%3Abamtech%3Aparams%3Aoauth%3Atoken-type%3Adevice";
    const t = await postForm("https://disney.api.edge.bamgrid.com/token", form, {authorization:DISNEY_KEY});
    if (statusCode(t) === 403 || /forbidden-location/i.test(t.body || "")) return result(name,S.NO,"","地区限制");
    const refresh = (safeJSON(t.body || "") || {}).refresh_token;
    if (!refresh) return result(name,S.ERROR,"","Token 响应异常");
    const payload = {query:"mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }",variables:{input:{refreshToken:refresh}}};
    const g = await postJSON("https://disney.api.edge.bamgrid.com/graph/v1/device/graphql", JSON.stringify(payload), {authorization:DISNEY_KEY});
    const body = String(g.body || "");
    const region = (body.match(/"countryCode"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const supported = (body.match(/"inSupportedLocation"\s*:\s*(true|false)/) || [])[1];
    if (supported === "true") return result(name,S.OK,region,"会话验证通过");
    if (supported === "false") return result(name,S.NO,region,"地区未开放");
    return result(name,S.ERROR,region,"会话响应无法识别");
  } catch(e) { return errResult(name,e); }
}

async function checkDazn() {
  const name = "DAZN";
  try {
    const body = JSON.stringify({LandingPageKey:"generic",Languages:"zh-CN,zh,en",Platform:"web",PlatformAttributes:{},Manufacturer:"",PromoCode:"",Version:"2"});
    const r = await postJSON("https://startup.core.indazn.com/misl/v5/Startup",body);
    if (statusCode(r) === 403) return result(name,S.BANNED,"","接口拒绝此 IP");
    const j = safeJSON(r.body || "");
    if (!j || !j.Region && !j.region) return result(name,S.ERROR,"","API 响应异常");
    const x = j.Region || j.region;
    const region = x.GeolocatedCountry || x.geolocatedCountry || "";
    const allowed = x.IsAllowed !== undefined ? x.IsAllowed : x.isAllowed;
    return allowed ? result(name,S.OK,region,"地区允许") : result(name,S.NO,region,x.DisallowedReason || x.disallowedReason || "地区限制");
  } catch(e) { return errResult(name,e); }
}

async function checkPrimeVideo() {
  const name = "Prime Video";
  try {
    const r = await get("https://www.primevideo.com", {opts:{redirection:true}});
    const body = String(r.body || "");
    if (/api-services-support@amazon\.com|captcha/i.test(body)) return result(name,S.BANNED,"","Amazon 风控");
    const m = body.match(/"currentTerritory"\s*:\s*"([A-Z]{2})"/i);
    if (m) return result(name,S.OK,m[1],"站点地区已识别");
    if (statusCode(r) === 200) return result(name,S.UNKNOWN,"","页面可达但地区未知");
    return result(name,S.NO,"","服务不可用");
  } catch(e) { return errResult(name,e); }
}

async function checkMax() {
  const name = "Max";
  try {
    const deviceId = "afbb5daa-c327-461d-9460-d8e4b3ee4a1f";
    const h = {"x-device-info":"beam/5.0.0 (desktop/desktop; Windows/10; "+deviceId+")","x-disco-client":"WEB:10:beam:5.2.1","x-disco-params":"realm=bolt"};
    const a = await get("https://default.any-any.prd.api.max.com/token?realm=bolt&deviceId="+deviceId,{headers:h});
    const token = safeJSON(a.body || "")?.data?.attributes?.token;
    if (!token) return result(name,statusCode(a)===403?S.BANNED:S.ERROR,"","Token 接口异常");
    const headers = Object.assign({Cookie:"st="+token},h);
    const b = await postJSON("https://default.any-any.prd.api.max.com/session-context/headwaiter/v1/bootstrap","{}",headers);
    const routing = safeJSON(b.body || "")?.routing;
    if (!routing || !routing.homeMarket) return result(name,S.NO,"","服务地区不可用");
    const base = `https://default.${routing.tenant}-${routing.homeMarket}.${routing.env}.${routing.domain}`;
    const me = await get(base+"/users/me",{headers});
    const region = safeJSON(me.body || "")?.data?.attributes?.currentLocationTerritory || routing.homeMarket;
    const p = await get("https://default.any-any.prd.api.max.com/any/playback/v1/playbackInfo",{headers});
    if (/VPN/i.test(String(p.body || ""))) return result(name,S.BANNED,region,"VPN/IP 被 Max 拒绝");
    return region ? result(name,S.OK,region,"会话地区已识别") : result(name,S.UNKNOWN,"","地区无法识别");
  } catch(e) { return errResult(name,e); }
}

async function checkDiscovery() {
  const name = "Discovery+";
  try {
    const common = {Origin:"https://www.discoveryplus.com",Referer:"https://www.discoveryplus.com/","x-disco-client":"WEB:UNKNOWN:dplus_us:2.46.0","x-disco-params":"bid=dplus,hn=www.discoveryplus.com"};
    const boot = await get("https://global-prod.disco-api.com/bootstrapInfo",{headers:common});
    const bj = safeJSON(boot.body || "");
    const text = String(boot.body || "");
    const base = bj?.data?.attributes?.baseApiUrl || bj?.baseApiUrl || (text.match(/"baseApiUrl"\s*:\s*"([^"]+)"/)||[])[1];
    const realm = bj?.data?.attributes?.realm || bj?.realm || (text.match(/"realm"\s*:\s*"([^"]+)"/)||[])[1];
    if (!base || !realm) return result(name,S.ERROR,"","Bootstrap 接口异常");
    if (realm === "dplusapac") return result(name,S.NO,"","亚太区尚未开放");
    const id = "qx"+Date.now().toString(16)+Math.random().toString(16).slice(2);
    const tr = await get(`${base}/token?deviceId=${id}&realm=${encodeURIComponent(realm)}&shortlived=true`,{headers:common});
    const token = safeJSON(tr.body || "")?.data?.attributes?.token;
    if (!token) return result(name,statusCode(tr)===403?S.BANNED:S.ERROR,"","Token 接口异常");
    const cr = await get(`${base}/cms/routes/tabbed-home?include=default`,{headers:Object.assign({Cookie:"st="+token},common)});
    const body = String(cr.body || "");
    const region = (body.match(/"mainTerritoryCode"\s*:\s*"([^"]+)"/)||[])[1] || "";
    if (/is unavailable in your|not yet available/i.test(body)) return result(name,S.NO,region,"地区限制");
    if (/relationships|included/.test(body)) return result(name,S.OK,region,"内容目录接口通过");
    return result(name,S.UNKNOWN,region,"目录响应无法识别");
  } catch(e) { return errResult(name,e); }
}

async function checkBBC() {
  const name = "BBC iPlayer";
  try {
    const r = await get("https://open.live.bbc.co.uk/mediaselector/6/select/version/2.0/mediaset/pc/vpid/bbc_one_london/format/json/jsfunc/JS_callbacks0");
    const body = String(r.body || "");
    if (/geolocation/i.test(body) || statusCode(r) === 403) return result(name,S.NO,"GB","地理限制");
    if (statusCode(r) === 200 && /media|connection|href|vs-hls-push-uk/i.test(body)) return result(name,S.OK,"GB","媒体选择器通过");
    return result(name,S.UNKNOWN,"","HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkITVX() {
  const name = "ITVX";
  try {
    const r = await get("https://simulcast.itv.com/playlist/itvonline/ITV", {headers:{"x-custom-headers":"true"},opts:{redirection:false}});
    if (statusCode(r) === 403) return result(name,S.NO,"GB","地理限制");
    if (statusCode(r) === 404 || statusCode(r) === 200) return result(name,S.OK,"GB","服务端点通过");
    return result(name,S.UNKNOWN,"","HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkChannel4() {
  const name = "Channel 4";
  try {
    const r = await get("https://www.channel4.com/simulcast/channels/C4", {opts:{redirection:false}});
    if (statusCode(r) === 403) return result(name,S.NO,"GB","地理限制");
    if (statusCode(r) === 200) return result(name,S.OK,"GB","直播页可用");
    return result(name,S.UNKNOWN,"","HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkParamount() {
  const name = "Paramount+";
  try {
    const r = await get("https://www.paramountplus.com/", {opts:{redirection:true}});
    const body = String(r.body || "");
    if (/geo.?restrict|not available in your (country|region)/i.test(body)) return result(name,S.NO,"","地区限制");
    if (/"intl"|intl\/|paramount\+/i.test(body) && statusCode(r) === 200) return result(name,S.OK,"","站点内容可用");
    return result(name,S.UNKNOWN,"","主页可达，无法确认内容解锁");
  } catch(e) { return errResult(name,e); }
}

async function checkPeacock() {
  const name = "Peacock";
  try {
    // Peacock 正常首页自身包含大量名为 unavailable 的组件/文案；
    // 只能用 HTTP 重定向目标判断地区封锁，不能扫描整个 HTML。
    const r = await get("https://www.peacocktv.com/", {opts:{redirection:false}});
    const code = statusCode(r);
    const loc = header(r,"location");
    if (code >= 300 && code < 400 && /(?:\/|\b)(?:unavailable|geo-availability)(?:[/?#]|\b)/i.test(loc)) {
      return result(name,S.NO,"US","重定向至地区不可用页面");
    }
    if (code === 200) return result(name,S.OK,"US","美国站首页可用");
    if (code >= 300 && code < 400) return result(name,S.UNKNOWN,"",loc ? "重定向："+loc : "未提供重定向目标");
    if (code === 403 || code === 451) return result(name,S.BANNED,"","访问被拒绝");
    return result(name,S.UNKNOWN,"","HTTP " + code);
  } catch(e) { return errResult(name,e); }
}

async function checkChatGPT() {
  const name = "ChatGPT";
  try {
    const [loc,r] = await Promise.all([cloudflareLoc("chatgpt.com"),get("https://chatgpt.com",{opts:{redirection:true}})]);
    const body = String(r.body || "");
    if (/VPN[^<]{0,80}(blocked|unsupported)|unsupported_country/i.test(body)) return result(name,S.BANNED,loc,"VPN/IP 被限制");
    if (statusCode(r) === 429) return result(name,S.LIMITED,loc,"429 限流");
    if (statusCode(r) === 200 && loc) return result(name,S.OK,loc,"入口可达");
    if (statusCode(r) === 403 && loc) return result(name,S.LIMITED,loc,"Cloudflare 验证，不能确认完整可用");
    return result(name,S.UNKNOWN,loc,"HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkClaude() {
  const name = "Claude";
  try {
    const [loc,r] = await Promise.all([cloudflareLoc("claude.ai"),get("https://claude.ai",{opts:{redirection:true}})]);
    const body = String(r.body || "");
    if (/not available in your (country|region)|unsupported_country/i.test(body)) return result(name,S.NO,loc,"地区限制");
    if (statusCode(r) === 429) return result(name,S.LIMITED,loc,"429 限流");
    if (statusCode(r) === 200 && loc) return result(name,S.OK,loc,"入口可达");
    if (statusCode(r) === 403 && loc) return result(name,S.LIMITED,loc,"访问验证，不能确认完整可用");
    return result(name,S.UNKNOWN,loc,"HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkCopilot() {
  const name = "Copilot";
  try {
    const r = await get("https://copilot.microsoft.com/c/api/user?api-version=2",{opts:{redirection:false}});
    if (statusCode(r) === 403 || (statusCode(r) === 302 && header(r,"location") === "/")) return result(name,S.NO,"","服务限制");
    const j = safeJSON(r.body || "");
    if (statusCode(r) === 200 && j && j.regionCode) return result(name,S.OK,j.regionCode,"用户接口通过");
    if (statusCode(r) === 200) return result(name,S.UNKNOWN,"","用户接口响应格式变化");
    return result(name,S.UNKNOWN,"","HTTP " + statusCode(r));
  } catch(e) { return errResult(name,e); }
}

async function checkTikTok() {
  const name = "TikTok";
  try {
    const r = await get("https://www.tiktok.com/explore");
    const body = String(r.body || "");
    if (body.includes("tiktok.com/hk/notfound")) return result(name,S.NO,"HK","地区页面不可用");
    const m = body.match(/"region"\s*:\s*"([A-Za-z]{2})"/);
    if (m) return result(name,S.OK,m[1],"地区已识别");
    if (statusCode(r) === 403 || statusCode(r) === 429) return result(name,S.BANNED,"","风控/限流");
    return result(name,S.UNKNOWN,"","页面结构无法识别");
  } catch(e) { return errResult(name,e); }
}

const CHECKS = [
  checkNetflix, checkDisney, checkYouTube, checkPrimeVideo, checkMax, checkDiscovery,
  checkBBC, checkITVX, checkChannel4, checkParamount, checkPeacock, checkDazn,
  checkChatGPT, checkClaude, checkCopilot, checkTikTok
];
const GROUPS = [
  ["🌍 国际流媒体", ["Netflix","Disney+","YouTube Premium","Prime Video","Max","Discovery+","Paramount+","Peacock","DAZN"]],
  ["🇬🇧 英国流媒体", ["BBC iPlayer","ITVX","Channel 4"]],
  ["🤖 AI 与社交", ["ChatGPT","Claude","Copilot","TikTok"]]
];

function renderRow(x, isLast) {
  const status = x.status;
  const detail = x.detail || "";
  const region = (x.region || "").toUpperCase();
  const flag = countryFlag(region);
  const regionBadge = region ? ` <span style="font-family:-apple-system,SF Pro Text,Menlo,monospace;font-weight:600;color:#007aff;">⟦${flag ? flag + " " : ""}${region}⟧</span>` : "";

  let statusHtml = "";
  if (status === S.OK) {
    statusHtml = `<span style="color:#28a745;font-weight:600;">✅ 支持</span>${regionBadge}`;
  } else if (status === S.LIMITED) {
    let sub = "受限";
    if (/自制/i.test(detail)) sub = "仅自制";
    else if (/验证/i.test(detail)) sub = "需验证";
    else if (/429/i.test(detail)) sub = "限流";
    statusHtml = `<span style="color:#ff9500;font-weight:600;">⚠️ ${sub}</span>${regionBadge}`;
  } else if (status === S.NO) {
    statusHtml = `<span style="color:#ff3b30;font-weight:600;">❌ 不支持</span>${regionBadge}`;
  } else if (status === S.BANNED) {
    statusHtml = `<span style="color:#af52de;font-weight:600;">⛔️ 封锁</span>${regionBadge}`;
  } else if (status === S.TIMEOUT) {
    statusHtml = `<span style="color:#8e8e93;font-weight:500;">⏱ 超时</span>`;
  } else if (status === S.ERROR) {
    statusHtml = `<span style="color:#ff3b30;font-weight:600;">❗️ 异常</span>`;
  } else {
    statusHtml = `<span style="color:#8e8e93;font-weight:500;">❔ 未知</span>${regionBadge}`;
  }

  const border = isLast ? "" : "border-bottom:0.5px solid rgba(128,128,128,0.15);";
  return `<tr><td style="padding:6px 0;text-align:left;font-weight:500;font-size:13.5px;white-space:nowrap;${border}">${escapeHTML(x.name)}</td><td style="padding:6px 0;text-align:right;font-size:13px;white-space:nowrap;${border}">${statusHtml}</td></tr>`;
}

function escapeHTML(s) { return String(s || "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function getPolicyName() {
  return new Promise(resolve => {
    if (typeof $configuration === "undefined" || !$configuration || !POLICY) return resolve(String(POLICY || "默认策略"));
    $configuration.sendMessage({action:"get_policy_state",content:POLICY}).then(r => {
      try {
        const v = r && r.ret && r.ret[POLICY];
        resolve(Array.isArray(v) ? v.join(" ➟ ") : (v || POLICY));
      } catch (_) { resolve(POLICY); }
    }, _ => resolve(POLICY));
  });
}

(async () => {
  const settled = await Promise.allSettled(CHECKS.map(fn => fn()));
  const rows = settled.map((v,i) => v.status === "fulfilled" ? v.value : errResult(CHECKS[i].name || "Unknown",v.reason));
  const byName = Object.fromEntries(rows.map(x => [x.name,x]));
  const node = await getPolicyName();

  let cards = "";
  for (const [title, names] of GROUPS) {
    const list = names.filter(n => byName[n]).map(n => byName[n]);
    if (!list.length) continue;
    const rowsHtml = list.map((x, i) => renderRow(x, i === list.length - 1)).join("");
    cards += `
      <div style="margin-top:10px;margin-bottom:4px;font-size:12.5px;font-weight:600;color:#8e8e93;letter-spacing:-0.2px;">${escapeHTML(title)}</div>
      <div style="background:rgba(128,128,128,0.08);border-radius:10px;padding:1px 12px;margin-bottom:8px;">
        <table style="width:100%;border-collapse:collapse;">
          ${rowsHtml}
        </table>
      </div>`;
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;padding:2px 4px;line-height:1.2;">
      ${cards}
      <div style="margin-top:10px;padding:7px 10px;background:rgba(205,92,92,0.12);border-radius:8px;font-size:12.5px;font-weight:600;color:#cd5c5c;text-align:center;">
        节点 ➟ ${escapeHTML(node)}
      </div>
      <div style="margin-top:6px;font-size:11px;color:#8e8e93;text-align:center;">
        “支持”仅代表当前公开端点通过 · 无法确认不误报
      </div>
    </div>`;

  $done({title:"📺 流媒体与 AI 解锁检测",htmlMessage:html});
})().catch(e => {
  $done({title:"📺 流媒体与 AI 解锁检测",htmlMessage:`<p>❗️ 主流程异常：${escapeHTML(e && (e.message || e))}</p>`});
});
