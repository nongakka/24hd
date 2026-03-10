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

const DOMAIN="https://24-hdmovie.com"
let COOKIE="wordpress_test_cookie=WP%20Cookie%20check"
const TEST_MODE = false
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
executablePath:"/usr/bin/google-chrome",
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

try{

if(depth>5){
console.log("IFRAME TOO DEEP")
return null
}

const html=await load(url)

console.log("IFRAME URL",url)
console.log("IFRAME HTML START")
console.log(html.slice(0,1200))
console.log("IFRAME HTML END")

const direct=findM3U8(html)

if(direct) return direct

const decoded=decodeVideoSources(html)
if(decoded) return decoded

const iframe=html.match(/<iframe[^>]+src="([^"]+)"/)

if(iframe){

return await getIframeVideo(iframe[1],depth+1)

}

}catch(e){}

return null
}

async function getVideo(id,nonce,referer){

try{

const form=new URLSearchParams()

form.append("action","doo_player_ajax")
form.append("post",id)
form.append("nume","1")
form.append("type","movie")
form.append("server","1")
console.log("AJAX BODY",form.toString())

const res = await cloudscraper.post({
url: DOMAIN + "/wp-admin/admin-ajax.php",
form: {
action:"doo_player_ajax",
post:id,
nume:1,
type:"movie",
server:1
},
headers:{
"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
"Accept":"*/*",
"Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
"X-Requested-With":"XMLHttpRequest",
"Origin":DOMAIN,
"Referer":referer
}
})

const body=res

console.log("PLAYER RESPONSE")
console.log(JSON.stringify(body).slice(0,800))

if(body && body.embed_url){

console.log("IFRAME",body.embed_url)

return await getIframeVideo(body.embed_url)

}

if(body && body.player && body.player.primary){

console.log("PRIMARY",body.player.primary)

return await getIframeVideo(body.player.primary)

}

}catch(e){

console.log("video error",e.message)

if(e.response){
console.log("STATUS",e.response.status)
console.log("RESPONSE",String(e.response.data).slice(0,1000))
}

}

return null
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
console.log("HOME HTML SAMPLE")
console.log(html.slice(0,1000))
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
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%8a%e0%b8%99%e0%b9%82%e0%b8%a3%e0%b8%87/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b9%84%e0%b8%97%e0%b8%a2/") ||
    link.includes("/%e0%b8%ab%e0%b8%99%e0%b8%b1%e0%b8%87%e0%b8%88%e0%b8%b5%e0%b8%99/") ||
    link.includes("/series/") ||
    link.includes("/marvel-universe/") ||
    link.includes("/dc-universe/") ||
    link.includes("/netflix/")
  )
){

const path = link.replace(/^https?:\/\/(www\.)?24-hdmovie\.com/,"")

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

const html=await load(url)

console.log("HTML LENGTH",html.length)
console.log("HTML SAMPLE")
console.log(html.slice(0,1000))

const $=cheerio.load(html)
$("a").slice(0,20).each((i,el)=>{

console.log("A TAG",$(el).attr("href"))

})


let found=0

$("article a, .item a, .post a, .movie a").each((i,el)=>{

const link=$(el).attr("href")

if(link &&
link.includes("24-hdmovie.com") &&
!link.includes("/category/") &&
!link.includes("/page/")
)
{

shows.push(link)
found++

}

})

console.log("FOUND SHOWS",found)
console.log("SHOW SAMPLE",shows.slice(0,5))
if(found===0){

console.log("END CATEGORY",path)
break

}

pageNum++

}catch(e){

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

const group=decodeURIComponent(cat)
.replace("/category/","")
.replace(/\//g,"")
console.log("CATEGORY",group)

jsonOutput[group]=[]

const file="24-hdmovie_"+group+".m3u"

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
await new Promise(r=>setTimeout(r,2000))
console.log("HTML CHECK NONCE")
console.log(html.slice(0,2000))


const nonce = extractNonce(html)
console.log("NONCE",nonce)

let postMatch = html.match(/post_id["']?\s*:\s*(\d+)/)

if(!postMatch){
postMatch = html.match(/postid-(\d+)/)
}

const postId = postMatch ? postMatch[1] : null

if(!postId){
console.log("POST ID NOT FOUND")
continue
}

console.log("POST ID MATCH",postMatch)
console.log("POST ID", postId)
console.log("NONCE", nonce)

const $=cheerio.load(html)

let title=$("meta[property='og:title']").attr("content") || show
title=title.replace(" -24-hdmovie","")

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

const iframe = await getIframeFromPage(show)

let video = convertToM3u8(iframe)

if(video){

if(usedVideos.includes(video)){
continue
}

usedVideos.push(video)

movie.episodes.push({
  name:"EP"+(i+1),
  servers:[
    {
      name:"24-hdmovie",
      url:video
    }
  ]
})

console.log("VIDEO",video)

const line=`#EXTINF:-1 tvg-name="${title} EP${i+1}" tvg-logo="${poster}" group-title="${group}",${title} EP${i+1}\n${video}\n\n`

fs.appendFileSync(file,line)

}

}

if(movie.episodes.length>0){

jsonOutput[group].push(movie)

fs.writeFileSync(
"24-hdmovie_"+group+".json",
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

const file="24-hdmovie_"+group+".json"

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

 const match = url.match(/id=([^&]+)/)

 if(match){
   const id = match[1]
   return `https://main.24playerhd.com/m3u8/${id}/${id}438.m3u8`
 }

 return null
}


;(async()=>{

await initBrowser()

await run()

process.exit()

})()


















