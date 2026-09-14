// Transcript rendering across scripts, including right-to-left.
//
// The transcript pane used to be one pre-wrapped string per track. That made
// the timestamp part of the line's bidi run, so "[0:00]" landed at the visual
// END of every Arabic and Hebrew line, and font-mono fell back mid-line for
// scripts it has no glyphs for. These checks pin the fix.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { group, check, summarise } from "./harness.mjs";
import { startProdServer } from "./prod-server.mjs";
const PORT=4183, BASE=`http://localhost:${PORT}`;
function findChrome(){if(process.env.CHROME_PATH)return process.env.CHROME_PATH;const r=process.env.PLAYWRIGHT_BROWSERS_PATH;if(!r)return null;
 for(const d of fs.readdirSync(r)){if(!d.startsWith("chromium-"))continue;
 const c=path.join(r,d,"chrome-linux/chrome");if(fs.existsSync(c))return c;}return null;}

// Real caption text in each script, with a past-the-hour timestamp to also
// exercise the hour fix.
const LANGS=[
 {code:"ar", name:"Arabic",   rtl:true,  lines:["مرحباً بكم في هذا الفيديو عن التدريب المتعمد","النقطة الأولى هي إيجاد حدود قدراتك","وهذا يستغرق أكثر من ساعة كاملة"]},
 {code:"he", name:"Hebrew",   rtl:true,  lines:["שלום וברוכים הבאים לסרטון הזה","העיקרון הראשון הוא למצוא את הגבול","זה לוקח יותר משעה שלמה"]},
 {code:"ja", name:"Japanese", rtl:false, lines:["このビデオへようこそ、意図的な練習について","第一の原則は自分の限界を見つけることです","これには一時間以上かかります"]},
 {code:"zh", name:"Chinese",  rtl:false, lines:["欢迎观看这个关于刻意练习的视频","第一个原则是找到你能力的边缘","这需要超过一个小时的时间"]},
 {code:"ko", name:"Korean",   rtl:false, lines:["의도적 연습에 관한 이 영상에 오신 것을 환영합니다","첫 번째 원칙은 자신의 한계를 찾는 것입니다","이것은 한 시간 이상 걸립니다"]},
 {code:"hi", name:"Hindi",    rtl:false, lines:["जानबूझकर अभ्यास पर इस वीडियो में आपका स्वागत है","पहला सिद्धांत अपनी क्षमता की सीमा खोजना है","इसमें एक घंटे से अधिक समय लगता है"]},
 {code:"th", name:"Thai",     rtl:false, lines:["ยินดีต้อนรับสู่วิดีโอเกี่ยวกับการฝึกฝนอย่างตั้งใจ","หลักการแรกคือการค้นหาขอบเขตความสามารถ","สิ่งนี้ใช้เวลามากกว่าหนึ่งชั่วโมง"]},
 {code:"ru", name:"Russian",  rtl:false, lines:["Добро пожаловать в это видео об осознанной практике","Первый принцип — найти предел своих возможностей","Это занимает больше часа"]},
];
const xmlFor=l=>`<?xml version="1.0" encoding="utf-8"?><transcript>`+
  l.lines.map((t,i)=>`<text start="${[0.5,65.8,3725][i]}" dur="4">${t.replace(/&/g,"&amp;")}</text>`).join("")+`</transcript>`;

const rec = (sev, where, what) => check(where, sev === "ok", what);

const s=await startProdServer({port:PORT});
const b=await chromium.launch({executablePath:findChrome()});

group("Transcript rendering per script (desktop + phone)");
for (const L of LANGS) {
  const META={tracks:[{languageCode:L.code,languageName:L.name,kind:"standard",isTranslatable:true,
    transcriptUrl:`https://www.youtube.com/api/timedtext?v=X&lang=${L.code}`,translationLanguages:[]}],
    source:"p",totalTracks:1};
  for (const w of [1280, 390]) {
    const ctx=await b.newContext({viewport:{width:w,height:900},isMobile:w<500,hasTouch:w<500});
    const page=await ctx.newPage();
    await page.route("**/*",r=>{const u=r.request().url();
      if(u.startsWith(BASE)&&!u.includes("/yt-timedtext")) return r.continue();
      if(u.includes("timedtext")) return r.fulfill({status:200,contentType:"text/xml; charset=utf-8",body:xmlFor(L)});
      if(u.includes("/oembed")) return r.fulfill({status:200,contentType:"application/json",
        body:JSON.stringify({title:L.name+" test",author_name:"A",author_url:"",thumbnail_url:""})});
      return r.fulfill({status:204,body:""});});
    await page.route(`${BASE}/api/transcript`,r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(META)}));
    await page.goto(`${BASE}/studio`,{waitUntil:"domcontentloaded"});
    await page.fill("input[placeholder='Paste YouTube link here...']","dQw4w9WgXcQ");
    await page.click("button:has-text('Load Video')");
    await page.waitForSelector("button:has-text('Transcript')",{timeout:25000});
    await page.click("button:has-text('Transcript')");
    await page.waitForTimeout(900);

    const pane=page.locator(".card.p-6 .overflow-y-auto").first();
    const txt=((await pane.textContent().catch(()=>"" ))||"").trim();
    const tag=`${L.name}/${w}`;

    if(!txt.includes(L.lines[0])) { rec("bug",tag,`text not rendered: "${txt.slice(0,50)}"`); await ctx.close(); continue; }

    // does the hour-aware timestamp survive?
    if(w===1280 && !txt.includes("1:02:05")) rec("bug",tag,`hour timestamp missing: ${(txt.match(/\d+:\d\d(:\d\d)?/g)||[]).join(" ")}`);

    // does the text overflow its container or the page?
    const docOv=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    const paneOv=await pane.evaluate(el=>el.scrollWidth-el.clientWidth);
    if(docOv>1) rec("bug",tag,`page overflows by ${docOv}px`);
    else if(paneOv>2) rec("bug",tag,`transcript overflows its box by ${paneOv}px (no wrap for this script)`);
    else rec("ok",tag,`renders, wraps, hour stamp ok`);

    // RTL: is the text actually laid out right-to-left?
    if(L.rtl && w===1280){
      const info=await page.evaluate(()=>{
        const row=document.querySelector(".card.p-6 .overflow-y-auto div > div");
        if(!row) return null;
        const stampEl=row.children[0], textEl=row.children[1];
        return {
          textDir: getComputedStyle(textEl).direction,
          stampX: Math.round(stampEl.getBoundingClientRect().x),
          textX: Math.round(textEl.getBoundingClientRect().x),
          stampFont: getComputedStyle(stampEl).fontFamily.split(",")[0],
        };
      });
      if(!info) rec("bug",`${L.name}/rtl`,"could not find a transcript row");
      else if(info.textDir!=="rtl") rec("bug",`${L.name}/rtl`,`caption direction="${info.textDir}" — should be rtl via dir="auto"`);
      else if(info.stampX >= info.textX) rec("bug",`${L.name}/rtl`,`timestamp at x=${info.stampX} is not left of the text at x=${info.textX}`);
      else rec("ok",`${L.name}/rtl`,`caption dir=rtl, timestamp column at x=${info.stampX} left of text at x=${info.textX}`);
    }
    await ctx.close();
  }
}
await b.close();
s.close();
summarise("Languages");
