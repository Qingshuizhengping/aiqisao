import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfqoAAAAASUVORK5CYII=';
async function evaluateStudio(context) {
    const modules = new Map();
    async function load(url) {
        if (modules.has(url.href)) return modules.get(url.href);
        const module = new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), { context, identifier: url.href });
        modules.set(url.href, module);
        await module.link((specifier, parent) => load(new URL(specifier, parent.identifier)));
        return module;
    }
    await (await load(entryUrl)).evaluate();
}
const entryUrl = new URL('../../src/studio.js', import.meta.url);
const source = fs.readFileSync(entryUrl, 'utf8');
const checks = [];
class Element {
    constructor(tag = 'div', id = '') { Object.assign(this, {tagName:tag.toUpperCase(),id,children:[],dataset:{},attributes:{},listeners:{},className:'',disabled:false,hidden:false,value:'',textContent:'',files:[],parentElement:null}); }
    setAttribute(name,value) {this.attributes[name]=String(value);if(name==='src')this.src=String(value);}
    getAttribute(name) {return name==='src'?this.src||null:this.attributes[name]??null;}
    removeAttribute(name) {delete this.attributes[name];if(name==='src')this.src='';}
    appendChild(child) {if(child.tagName==='#FRAGMENT'){for(const nested of [...child.children])this.appendChild(nested);return child;}child.parentElement=this;this.children.push(child);return child;}
    append(...children) {for(const child of children)this.appendChild(child);}
    replaceChildren(...children) {this.children=[];this.append(...children);}
    addEventListener(type,listener) {(this.listeners[type]||=[]).push(listener);}
    async dispatch(type,target=this,properties={}) {await Promise.all((this.listeners[type]||[]).map(listener=>listener({target,preventDefault(){},...properties})));}
    async click() {if(this.disabled)return;await this.dispatch('click');let parent=this.parentElement;while(parent){await parent.dispatch('click',this);parent=parent.parentElement;}}
    contains(child) {return this===child||this.children.some(element=>element.contains(child));}
    closest(selector) {if(selector==='button[data-reference-index]'){if(this.tagName==='BUTTON'&&this.dataset.referenceIndex!==undefined)return this;}else if(selector.startsWith('.')&&this.className.split(' ').includes(selector.slice(1)))return this;return this.parentElement?.closest(selector)||null;}
    querySelectorAll(selector) {const descendants=this.children.flatMap(child=>[child,...child.querySelectorAll('*')]);if(selector==='*')return descendants;return descendants.filter(child=>selector.startsWith('.')?child.className.split(' ').includes(selector.slice(1)):child.tagName.toLowerCase()===selector);}
    focus() {}
}
async function setup(options={}) {
    const ids='prompt charCount presets sizeChips sizeNote refInput refLabel refClear refPreview refCount generateBtn generateLabel serviceStatus stageEmpty stageLoading stageResult stageError loadingText resultImg downloadBtn asRefBtn againBtn resultPrompt errorText errorRetry historyGrid historyClear lightbox lightboxImg lightboxClose themeToggle optimizeToggle optimizeStatus useOriginalBtn stageClarification clarificationQuestion clarificationEdit optimizationDetails originalPromptDisplay optimizedPromptDisplay'.split(' ');
    const elements=Object.fromEntries(ids.map(id=>[id,new Element('div',id)]));
    const serviceContainer = new Element('div');
    serviceContainer.appendChild(elements.serviceStatus);
    for(const id of ['generateBtn','refClear','asRefBtn','againBtn','errorRetry','historyClear','lightboxClose','themeToggle'])elements[id].tagName='BUTTON';
    const refPick=new Element('label');refPick.className='ref-pick';
    for(const size of ['1:1','3:4','auto']){const chip=new Element('button');chip.className='size-chip';chip.dataset.size=size;chip.setAttribute('aria-pressed',String(size==='1:1'));elements.sizeChips.appendChild(chip);}
    const preset=new Element('button');preset.className='chip';preset.dataset.prompt='preset';elements.presets.appendChild(preset);
    const storage=options.storage||new Map();const requests=[];const preparations=[];const confirmations=[];const timeoutDurations=[];const virtualTimers=new Map();let virtualNow=0;let nextTimerId=1;
    function scheduleTimeout(callback,duration){timeoutDurations.push(duration);if(!options.virtualTimers)return setTimeout(callback,duration);const timerId=nextTimerId++;virtualTimers.set(timerId,{due:virtualNow+duration,callback});return timerId;}
    function removeTimeout(timerId){assert.notEqual(timerId,null);if(options.virtualTimers)virtualTimers.delete(timerId);else clearTimeout(timerId);}
    function advanceTime(duration){virtualNow+=duration;for(const [timerId,timer] of [...virtualTimers])if(timer.due<=virtualNow){virtualTimers.delete(timerId);timer.callback();}}
    class Reader {
        readAsDataURL(file) {
            const complete = () => {
                if (file.fail) { this.onerror?.(); return; }
                this.result = file.dataUrl || png;
                this.onload?.();
            };
            if (options.readFile) Promise.resolve().then(() => options.readFile(file)).then(complete, () => this.onerror?.());
            else setTimeout(complete, 5);
        }
    }
    class Image {constructor(){this.naturalWidth=16;this.naturalHeight=16;}set src(value){setTimeout(()=>value.includes('broken')?this.onerror?.():this.onload?.(),5);}}
    const documentListeners={};const document={
        hidden:false,dispatch(type){for(const listener of documentListeners[type]||[])listener({type});},documentElement:{dataset:{theme:'light'}},getElementById:id=>elements[id],
        querySelector:selector=>selector==='.ref-pick[for="refInput"]'?refPick:null,
        querySelectorAll:selector=>selector.startsWith('meta')?[]:[...elements.refPreview.querySelectorAll('.ref-remove'),...elements.sizeChips.children,...elements.presets.children],
        createDocumentFragment:()=>new Element('#fragment'),
        createElement(tag){if(tag==='canvas')return {getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=>png.replace('image/png','image/jpeg')};return new Element(tag);},addEventListener(type,listener){(documentListeners[type]||=[]).push(listener);},removeEventListener(type,listener){documentListeners[type]=(documentListeners[type]||[]).filter(existing=>existing!==listener);},
    };
    const context=vm.createContext({document,window:{listeners:{},addEventListener(type,listener){(this.listeners[type]||=[]).push(listener);},removeEventListener(){},dispatch(type,event={}){for(const listener of this.listeners[type]||[])listener({type,...event});},crypto:webcrypto,TextEncoder,confirm:message=>{confirmations.push(message);return options.confirm!==false;}},TextEncoder,location:{search:''},URL,URLSearchParams,AbortController,AbortSignal,FileReader:Reader,Image,setTimeout:scheduleTimeout,clearTimeout:removeTimeout,setInterval(){throw new Error('Loading must not start an elapsed-time interval');},clearInterval,console,
        localStorage:{get length(){return storage.size;},key:index=>Array.from(storage.keys())[index]??null,getItem:key=>storage.get(key)||null,removeItem:key=>storage.delete(key),setItem:(key,value)=>{if(options.failStorage||options.failHistory&&key==='qisao_studio_history')throw Error('Storage unavailable');storage.set(key,value);}},
        async fetch(url,requestOptions){if(url.startsWith('/api/image/jobs'))return options.jobHandler(url,requestOptions);if(url==='/api/health')return {ok:true,json:async()=>options.health||{imageReady:true}};if(url==='/api/image/prepare'){const payload=JSON.parse(requestOptions.body);preparations.push(payload);if(options.prepare)return options.prepare(payload,requestOptions);return {ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'test-token',originalPrompt:payload.prompt,optimizedPrompt:'optimized '+payload.prompt,intent:'generate',expiresAt:Date.now()+30000})};}if(url==='/api/image'){requests.push(JSON.parse(requestOptions.body));await new Promise(resolve=>setTimeout(resolve,10));if(options.image)return options.image(requests.at(-1));return {ok:true,status:200,json:async()=>({status:'ok',url:'/static/gen/fixture.png'})};}return {ok:true,blob:async()=>({size:256,type:'image/png',dataUrl:png})};}
    });
    await evaluateStudio(context);
    return {elements,storage,requests,refPick,preparations,confirmations,timeoutDurations,advanceTime,document,window:context.window};
}

export { setup, png };
