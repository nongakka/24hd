process.env.NODE_TLS_REJECT_UNAUTHORIZED="0"

const puppeteer = require("puppeteer-extra")
const StealthPlugin = require("puppeteer-extra-plugin-stealth")

puppeteer.use(StealthPlugin())
const cloudscraper=require("cloudscraper").defaults({
jar:true
})
const cheerio=require("cheerio")
const fs=require("fs")
const https=require("https")
const { execSync } = require("child_process")
const agent=new https.Agent({rejectUnauthorized:false})

const DOMAIN="https://www.24-hds.com"
let COOKIE="wordpress_test_cookie=WP%20Cookie%20check"
const TEST_MODE = true   //false  true
let progress={
show:null,
episodeIndex:0
}

if(fs.existsSync("progress.json")){

try{

progress=JSON.parse(fs.readFileSync("progress.json"))

}catch(e){

console.log("PROGRESS READ ERROR")

}

}

function saveProgress(show,episodeIndex){

progress.show=show
progress.episodeIndex=episodeIndex
progress.updated=new Date().toISOString()

fs.writeFileSync(
"progress.json",
JSON.stringify(progress,null,2)
)
}

function gitCommit(){

try{

execSync('git config --global user.name "github-actions"')
execSync('git config --global user.email "actions@github.com"')

execSync("git add *.json *.m3u progress.json")

execSync('git commit -m "crawler progress"')

execSync("git pull --rebase")

execSync("git push")

console.log("GIT COMMIT")

}catch(e){

console.log("GIT ERROR")
console.log(e.message)

}

}

let browser
let page

async function initBrowser(){

browser = await puppeteer.launch({
headless:true,
args:[
"--no-sandbox",
"--disable-setuid-sandbox",
"--disable-dev-shm-usage"
]
})

page = await browser.newPage()

await page.setViewport({width:1366,height:768})

await page.setExtraHTTPHeaders({
"accept-language":"th-TH,th;q=0.9,en;q=0.8"
})

await page.setUserAgent(
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
)

}

async function getIframeFromPage(url){

console.log("OPEN PAGE",url)

await page.goto(url,{waitUntil:"networkidle2"})

await new Promise(r => setTimeout(r,6000))

const iframe = await page.evaluate(()=>{

const el=document.querySelector("iframe")

return el ? el.src : null

})

console.log("IFRAME SRC",iframe)

const stream = convertToM3u8(iframe)

console.log("STREAM",stream)

return iframe

}


async function load(url){

console.log("LOAD",url)

await page.goto(url,{
waitUntil:"domcontentloaded",
timeout:60000
})

await new Promise(r=>setTimeout(r,8000))

let html = await page.content()

if(
html.includes("Just a moment") ||
html.includes("challenge-platform") ||
html.includes("รอสักครู่")
){

console.log("CLOUDFLARE WAIT...")

await new Promise(r=>setTimeout(r,10000))

html = await page.content()

}

return html

}




function findM3U8(html){

const m=html.match(/https?:\/\/[^"' ]+\.(m3u8|txt)[^"' ]*/)

if(m) return m[0]

return null
}

function extractNonce(html){

let m = html.match(/halim_nonce\s*=\s*['"]([^'"]+)['"]/)
if(m) return m[1]

m = html.match(/"_wpnonce":"([^"]+)"/)
if(m) return m[1]

m = html.match(/data-nonce="([^"]+)"/)
if(m) return m[1]

m = html.match(/nonce["']?\s*[:=]\s*["']([^"']+)["']/)
if(m) return m[1]

return "none"

}

function decodeVideoSources(html){

const scriptRegex=/<script[^>]*>([\s\S]*?)<\/script>/gi
let match

while((match=scriptRegex.exec(html))!==null){

const script=match[1]

if(!script.includes("videoSources")) continue

const server=script.match(/"videoServer":"(\d+)"/)
const source=script.match(/"videoSources":\[\{"file":"([^"]+)"/)
const host=script.match(/"hostList":(\{.*?\})/)

if(server && source && host){

const videoServer=server[1]
let videoFile=source[1]

let hostList

try{
hostList=JSON.parse(host[1])
}catch(e){
continue
}

if(hostList[videoServer]){

let domain=hostList[videoServer][0]

domain=domain.replace(/[\[\]']/g,"").trim()

let url=videoFile.replace(
/https:\\\/\\\/\d+\\\/cdn\\\/hls\\\//,
"https://"+domain+"/api/files/"
)

url=url.replace(/\\\//g,"/")

return url

}

}

}

return null
}

async function getIframeVideo(url,depth=0){

let html = ""

try{

if(depth>5){
console.log("IFRAME TOO DEEP")
return null
}

html = await load(url)

console.log("IFRAME URL",url)
//console.log("IFRAME HTML START")
//console.log(html.slice(0,1200))
//console.log("IFRAME HTML END")

const direct=findM3U8(html)

if(direct) return direct

const decoded=decodeVideoSources(html)
if(decoded) return decoded

const iframe=html.match(/<iframe[^>]+src="([^"]+)"/)

if(iframe){

  let url = iframe[1]

  console.log("IFRAME FOUND", url)

  // 🔥 เคสสำคัญ: index_th.php → แปลงเป็น m3u8 ทันที
  if(url.includes("index_th.php")){
    const idMatch = url.match(/id=([a-zA-Z0-9]+)/)
    if(idMatch){
      const id = idMatch[1]
      const m3u8 = `https://main.24playerhd.com/newplaylist/${id}/${id}.m3u8`
      console.log("M3U8 FROM IFRAME URL", m3u8)
      return m3u8
    }
  }

  return await getIframeVideo(url,depth+1)

}

}catch(e){}

// 🔥 ดึง id จาก index_th.php หรือ URL ที่มี id
let idMatch =
  html.match(/id=([a-zA-Z0-9]+)/) ||
  html.match(/\/([a-z0-9]{24,})/i)

if(idMatch){
  const id = idMatch[1]
  const m3u8 = `https://main.24playerhd.com/newplaylist/${id}/${id}.m3u8`
  console.log("M3U8 FROM ID", m3u8)
  return m3u8
}

return null
}

async function getVideo(id, nonce, referer, lang){

try{

console.log("USE PUPPETEER AJAX")

const result = await page.evaluate(async (id, lang) => {

  const formData = new URLSearchParams()
 console.log("EVALUATE START", id)
	formData.append("action","halim_ajax_player")
	formData.append("episode","1")
	formData.append("postid",id)
	formData.append("lang", lang)
	formData.append("server","1")

  const res = await fetch("/wp-admin/admin-ajax.php", {
  method: "POST",
  credentials: "include", // 🔥 สำคัญ
  headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01"
  },
  body: formData.toString()
})

  const text = await res.text()

// 🔥 DEBUG ดูก่อนว่าได้อะไร
console.log("AJAX TEXT", text.slice(0,300))

let json = null

try{
  json = JSON.parse(text)
}catch(e){
  console.log("NOT JSON RESPONSE")
  return null
}

console.log("AJAX RAW", JSON.stringify(json).slice(0,500))

// 🔥 DEBUG ดูโครงสร้างจริง
console.log("AJAX RAW", JSON.stringify(json).slice(0,500))

return json

}, id, lang).catch(e => {
  console.log("EVALUATE ERROR", e.message)
  return null
})

console.log("PLAYER RESPONSE OK")

if(result && result.embed_url){
  return await getIframeVideo(result.embed_url)
}

if(result && result.player && result.player.primary){
  return await getIframeVideo(result.player.primary)
}

}catch(e){
console.log("PUPPETEER AJAX ERROR", e.message)
}

return null
}

async function getIframeByLang(postId, lang){

  console.log("GET IFRAME LANG", lang)

  const html = await page.evaluate(async (id, lang) => {

    const formData = new URLSearchParams()

    formData.append("action","halim_ajax_player")
    formData.append("episode","1")
    formData.append("postid", id)
    formData.append("server","1")
    formData.append("lang", lang)
    formData.append("nonce","")

    const res = await fetch("https://api.24-hdmovie.com/get.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    })

    return await res.text()

  }, postId, lang)

  console.log("AJAX HTML", html?.slice(0,200))

  const iframe = html.match(/src="([^"]+)"/)?.[1]

  console.log("IFRAME LANG", lang, iframe)

  return iframe
}



async function getEpisodes(url){

const html=await load(url)

const $=cheerio.load(html)

let ids=[]

$("span.episode[episode-id], .mp-ep-btn[data-id]").each((i,el)=>{

let id=$(el).attr("episode-id")

if(!id) id=$(el).attr("data-id")

if(id) ids.push(id)

})

return [...new Set(ids)]
}

async function getCategories(){

console.log("READ MENU")
await load(DOMAIN)
console.log("WARMUP DONE")

const html=await load(DOMAIN)
console.log("HOME HTML LENGTH",html.length)
const $=cheerio.load(html)

let cats=[]

$("a").each((i,el)=>{

const link=$(el).attr("href")

if(
  link &&
  (
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%83%e0%b8%ab%e0%b8%a1%e0%b9%88-2026/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%83%e0%b8%ab%e0%b8%a1%e0%b9%88-2025/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%83%e0%b8%ab%e0%b8%a1%e0%b9%88-2024/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%9d%e0%b8%a3%e0%b8%b1%e0%b9%88%e0%b8%87/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%84%e0%b8%97%e0%b8%a2/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%88%e0%b8%b5%e0%b8%99/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%8d%e0%b8%b5%e0%b9%88%e0%b8%9b%e0%b8%b8%e0%b9%88%e0%b8%99/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%80%e0%b8%81%e0%b8%b2%e0%b8%ab%e0%b8%a5%e0%b8%b5/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%a0%e0%b8%b2%e0%b8%84%e0%b8%95%e0%b9%88%e0%b8%ad/") ||
    link.includes("/marvel-universe/") ||
    link.includes("/dc-universe/") ||
    link.includes("/netflix/") ||
    link.includes("/18/") 
  )

){

const path = link.replace(/^https?:\/\/(www\.)?24-hds\.com/,"")

cats.push(path)

}

})

return [...new Set(cats)]

}

async function scanCategory(path){

let shows=[]
let pageNum=1

while(true){
if(TEST_MODE && pageNum > 1){
break
}
const url = pageNum === 1
  ? DOMAIN + path
  : DOMAIN + path + "page/" + pageNum + "/"

console.log("SCAN",url)

try{

const html = await load(url)
const $ = cheerio.load(html)

let found = 0

$("a").each((i, el) => {

  // 🔥 เอาเฉพาะการ์ดหนัง
  if($(el).find(".box-img").length === 0) return

  const link = $(el).attr("href")

  if(
    link &&
    link.startsWith(DOMAIN) &&
    !link.includes("/wp-") &&
    !link.includes("/category/") &&
    !link.includes("/page/")
  ){
    shows.push(link)
    found++
  }

})

shows = [...new Set(shows)]

console.log("FOUND SHOWS",found)
//console.log("SHOW SAMPLE",shows.slice(0,5))

if(found===0){
console.log("END CATEGORY",path)
break

}

pageNum++

}catch(e){
console.log("SCAN ERROR",e.message)
break

}

}

return [...new Set(shows)]

}

async function run(){

const categories=await getCategories()
const testCategories = TEST_MODE ? categories.slice(0,1) : categories
console.log("CATEGORIES",categories.length)

let scannedShows=[]

let usedVideos=[]

let jsonOutput={}

let movieCount = 0
  
let resume = progress.show ? false : true

for(const cat of testCategories){

const group = decodeURIComponent(cat)
.replace(/^\/|\/$/g,"")   // ตัด / หน้า-หลัง
console.log("CATEGORY",group)

jsonOutput[group]=[]

const file="24-hds_"+group+".m3u"

if(!fs.existsSync(file)){
fs.writeFileSync(file,"#EXTM3U\n\n")
}

const shows=await scanCategory(cat)
const testShows = TEST_MODE ? shows.slice(0,1) : shows
for(const show of testShows){
console.log("PROCESS SHOW",show)

if(TEST_MODE && jsonOutput[group].length >= 1){
break
}

if(!resume){

if(show===progress.show){

resume=true

}else{

continue

}

}

try{

console.log("SHOW",show)

const html = await load(show)

// 🔥 สำคัญ: ให้ browser อยู่หน้า show จริงก่อนยิง AJAX
await page.goto(show, { waitUntil: "domcontentloaded" })

// 🔥 รอ element player จริง
await page.waitForSelector("iframe", { timeout: 15000 }).catch(()=>{})

// 🔥 delay เพิ่มให้ JS โหลดครบ
await new Promise(r => setTimeout(r, 5000))
const nonce = extractNonce(html)
console.log("NONCE",nonce)

let postMatch =
  html.match(/post_id["']?\s*:\s*(\d+)/) ||
  html.match(/postid-(\d+)/) ||
  html.match(/id=["']post-(\d+)/)

const postId = postMatch ? postMatch[1] : null

if(!postId){
console.log("POST ID NOT FOUND")
continue
}

console.log("POST ID", postId)
console.log("NONCE", nonce)

const $=cheerio.load(html)

let title=$("meta[property='og:title']").attr("content") || show
title=title.replace(/-? ?24-hds/i,"")

let poster=$("meta[property='og:image']").attr("content") || ""

let movie={
  title:title,
  image:poster,
  episodes:[]
}

if(scannedShows.includes(show)) continue

scannedShows.push(show)

let episodes = await getEpisodes(show)

if(!Array.isArray(episodes)){
episodes=[]
}

if(episodes.length === 0 && postId){
episodes = [postId]
}

console.log("EPISODES",episodes.length)

episodes = episodes.map(e=>String(e))

episodes.sort((a,b)=>Number(a)-Number(b))

for(let i=0;i<episodes.length;i++){

if(TEST_MODE && i >= 1){
break
}

if(show===progress.show && i<progress.episodeIndex){
continue
}

const id=episodes[i]

console.log("EP",i+1,"ID",id)

saveProgress(show,i)

const langs = [
  { name: "TH", value: "Thai" },
  { name: "EN", value: "Sound Track" }
]

  // 🔥 เปิดหน้าใหม่พร้อม param ภาษา
  for(const lang of langs){

  // 🔥 โหลดหน้าแยกตามภาษา
  const iframe = await getIframeByLang(id, lang.value)

if(!iframe){
  console.log("NO IFRAME", lang.name)
  continue
}

const video = convertToM3u8(iframe)

  console.log("VIDEO RAW", lang.name, video)

  if(!video) continue

  if(usedVideos.includes(video)){
    console.log("DUPLICATE BUT KEEP (multi-lang)", video)
  }else{
    usedVideos.push(video)
  }

  if(episodes.length === 1){
  epName = "Full Movie"
}else{
  epName = "EP" + (i+1)
}

  let ep = movie.episodes.find(e => e.name === epName)

  if(!ep){
    ep = {
      name: epName,
      servers:[]
    }
    movie.episodes.push(ep)
  }

  ep.servers.push({
    name: lang.name,
    url: video
  })

  console.log("VIDEO", lang.name, video)

  const line=`#EXTINF:-1 tvg-name="${title} EP${i+1} ${lang.name}" tvg-logo="${poster}" group-title="${group}",${title} EP${i+1} ${lang.name}\n${video}\n\n`

  fs.appendFileSync(file,line)

}


}

if(movie.episodes.length>0){

jsonOutput[group].push(movie)

fs.writeFileSync(
"24-hds_"+group+".json",
JSON.stringify(jsonOutput[group],null,2)
)
  
if(movie.episodes.length > 1){

// series
gitCommit()

}else{

// movie
movieCount++

if(movieCount % 20 === 0){
  gitCommit()
}
}
}
}catch(e){

console.log("SHOW ERROR",e.message)

}

}

}

for(const group in jsonOutput){

const file="24-hds_"+group+".json"

fs.writeFileSync(
file,
JSON.stringify(jsonOutput[group],null,2)
)

console.log("JSON CREATED",file)

}

console.log("JSON CREATED GROUPS",Object.keys(jsonOutput).length)

console.log("DONE IPTV CREATED")

}

function convertToM3u8(url){

 if(!url) return null

 if(url.includes(".m3u8")) return url

 const idMatch = url.match(/id=([a-zA-Z0-9]+)/)
const bMatch = url.match(/b=(\d+)/)

if(idMatch){
  const id = idMatch[1]

  // 🔥 ถ้ามี b → ใช้ b แยก stream
  if(bMatch){
    const b = bMatch[1]
    return `https://main.24playerhd.com/newplaylist/${id}/${b}.m3u8`
  }

  return `https://main.24playerhd.com/newplaylist/${id}/${id}.m3u8`
}

 return null
}


;(async()=>{

await initBrowser()

await run()

process.exit()

})()
