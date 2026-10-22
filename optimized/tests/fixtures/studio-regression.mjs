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
    for(const id of ['generateBtn','refClear','asRefBtn','againBtn','errorRetry','historyClear','lightboxClose','themeToggle'])elements[id].tagName='BUTTON';
    const refPick=new Element('label');refPick.className='ref-pick';
    for(const size of ['1:1','3:4','auto']){const chip=new Element('button');chip.className='size-chip';chip.dataset.size=size;chip.setAttribute('aria-pressed',String(size==='1:1'));elements.sizeChips.appendChild(chip);}
    const preset=new Element('button');preset.className='chip';preset.dataset.prompt='preset';elements.presets.appendChild(preset);
    const storage=new Map();const requests=[];const preparations=[];const confirmations=[];const timeoutDurations=[];const virtualTimers=new Map();let virtualNow=0;let nextTimerId=1;
    function scheduleTimeout(callback,duration){timeoutDurations.push(duration);if(!options.virtualTimers)return setTimeout(callback,duration);const timerId=nextTimerId++;virtualTimers.set(timerId,{due:virtualNow+duration,callback});return timerId;}
    function removeTimeout(timerId){assert.notEqual(timerId,null);if(options.virtualTimers)virtualTimers.delete(timerId);else clearTimeout(timerId);}
    function advanceTime(duration){virtualNow+=duration;for(const [timerId,timer] of [...virtualTimers])if(timer.due<=virtualNow){virtualTimers.delete(timerId);timer.callback();}}
    class Reader {readAsDataURL(file){setTimeout(()=>{if(file.fail){this.onerror?.();return;}this.result=file.dataUrl||png;this.onload?.();},5);}}
    class Image {constructor(){this.naturalWidth=16;this.naturalHeight=16;}set src(value){setTimeout(()=>value.includes('broken')?this.onerror?.():this.onload?.(),5);}}
    const document={
        documentElement:{dataset:{theme:'light'}},getElementById:id=>elements[id],
        querySelector:selector=>selector==='.ref-pick[for="refInput"]'?refPick:null,
        querySelectorAll:selector=>selector.startsWith('meta')?[]:[...elements.refPreview.querySelectorAll('.ref-remove'),...elements.sizeChips.children,...elements.presets.children],
        createDocumentFragment:()=>new Element('#fragment'),
        createElement(tag){if(tag==='canvas')return {getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=>png.replace('image/png','image/jpeg')};return new Element(tag);},hidden:false,addEventListener(){},removeEventListener(){},
    };
    const context=vm.createContext({document,window:{addEventListener(){},removeEventListener(){},crypto:webcrypto,TextEncoder,confirm:message=>{confirmations.push(message);return options.confirm!==false;}},TextEncoder,location:{search:''},URL,URLSearchParams,AbortController,AbortSignal,FileReader:Reader,Image,setTimeout:scheduleTimeout,clearTimeout:removeTimeout,setInterval(){throw new Error('Loading must not start an elapsed-time interval');},clearInterval,console,
        localStorage:{get length(){return storage.size;},key:index=>Array.from(storage.keys())[index]??null,getItem:key=>storage.get(key)||null,removeItem:key=>storage.delete(key),setItem:(key,value)=>storage.set(key,value)},
        async fetch(url,requestOptions){if(url==='/api/health')return {ok:true,json:async()=>options.health||{imageReady:true}};if(url==='/api/image/prepare'){const payload=JSON.parse(requestOptions.body);preparations.push(payload);if(options.prepare)return options.prepare(payload,requestOptions);return {ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'test-token',originalPrompt:payload.prompt,optimizedPrompt:'optimized '+payload.prompt,intent:'generate',expiresAt:Date.now()+30000})};}if(url==='/api/image'){requests.push(JSON.parse(requestOptions.body));await new Promise(resolve=>setTimeout(resolve,10));if(options.image)return options.image(requests.at(-1),requestOptions);return {ok:true,status:200,json:async()=>({status:'ok',url:'/static/gen/fixture.png'})};}return {ok:true,blob:async()=>({size:256,type:'image/png',dataUrl:png})};}
    });
    await evaluateStudio(context);
    return {elements,storage,requests,refPick,preparations,confirmations,timeoutDurations,advanceTime};
}
async function check(name,task){try{await task();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:error.stack});}}
const file=(name='reference.png',dataUrl=png)=>({name,type:'image/png',size:256,dataUrl});
async function select(test,files){test.elements.refInput.files=files;await test.elements.refInput.dispatch('change');}
function count(test){return test.elements.refPreview.children.length;}
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));

await check('initial state preserves square default and zero references',async()=>{const test=await setup();await pause();assert.equal(count(test),0);assert.equal(test.elements.sizeNote.textContent,'默认 1:1 · 2K');assert.equal(test.elements.refCount.textContent,'0 / 20 张');});
await check('batch selection appends in order and individual removal preserves order',async()=>{const test=await setup();await select(test,[file('one.png'),file('two.png')]);await select(test,[file('three.png')]);assert.equal(count(test),3);assert.deepEqual(test.elements.refPreview.children.map(item=>item.children[0].title),['one.png','two.png','three.png']);await test.elements.refPreview.children[1].children[1].click();assert.deepEqual(test.elements.refPreview.children.map(item=>item.children[0].title),['one.png','three.png']);});
await check('clear removes references and resets controls',async()=>{const test=await setup();await select(test,[file(),file()]);await test.elements.refClear.click();assert.equal(count(test),0);assert.equal(test.elements.refInput.disabled,false);assert.equal(test.elements.refClear.hidden,true);});
await check('twenty references accepted and twenty-first rejected without loss',async()=>{const test=await setup();await select(test,Array.from({length:20},(_,index)=>file(index+'.png')));assert.equal(count(test),20);assert.equal(test.elements.refInput.disabled,true);assert.equal(test.elements.asRefBtn.disabled,true);await select(test,[file('overflow.png')]);assert.equal(count(test),20);assert.match(test.elements.errorText.textContent,/最多添加 20/);});
await check('invalid MIME and oversized source reject before processing',async()=>{const test=await setup();await select(test,[file('saved.png')]);await select(test,[{...file(),type:'image/svg+xml'}]);assert.equal(count(test),1);assert.match(test.elements.errorText.textContent,/PNG/);await select(test,[{...file(),size:20*1024*1024+1}]);assert.equal(count(test),1);assert.match(test.elements.errorText.textContent,/20MB/);assert.equal(test.requests.length,0);});
await check('batch read failure keeps existing references and discards whole batch',async()=>{const test=await setup();await select(test,[file('saved.png')]);await select(test,[file('ok.png'),{...file('broken.png'),fail:true}]);assert.equal(count(test),1);assert.equal(test.elements.refPreview.children[0].children[0].title,'saved.png');assert.equal(test.elements.refInput.disabled,false);assert.match(test.elements.errorText.textContent,/读取图片失败/);});
await check('decode failure is visible and never sent upstream',async()=>{const test=await setup();await select(test,[file('broken.png','data:image/png;base64,broken')]);assert.equal(count(test),0);assert.match(test.elements.errorText.textContent,/无法读取/);assert.equal(test.requests.length,0);});
await check('reading locks generation and all reference mutations',async()=>{const test=await setup();await select(test,[file('saved.png')]);test.elements.prompt.value='test';test.elements.refInput.files=[file('next.png')];const processing=test.elements.refInput.dispatch('change');assert.equal(test.elements.generateBtn.disabled,true);assert.equal(test.elements.refClear.disabled,true);assert.equal(test.elements.refPreview.children[0].children[1].disabled,true);assert.equal(test.elements.asRefBtn.disabled,true);assert.equal(test.refPick.getAttribute('aria-disabled'),'true');await test.elements.generateBtn.click();await test.elements.refClear.click();await processing;assert.equal(count(test),2);assert.equal(test.requests.length,0);assert.equal(test.elements.generateBtn.disabled,false);});
await check('automatic size and ordered array are sent without legacy singular field',async()=>{const test=await setup();await select(test,[file('one.png'),file('two.png')]);await test.elements.sizeChips.children[2].click();assert.equal(test.elements.sizeNote.textContent,'自动 · 模型自适应');test.elements.prompt.value='test';const processing=test.elements.generateBtn.click();assert.equal(test.elements.refInput.disabled,true);assert.equal(test.elements.loadingText.textContent,'正在生成并保存…');await processing;assert.equal(test.requests.length,1);assert.equal(test.requests[0].size,'auto');assert.equal(test.requests[0].referenceImages.length,2);assert.equal('referenceImage' in test.requests[0],false);assert.equal([...test.storage.values()].some(value=>value.includes('data:image')),false);});
await check('result as reference appends rather than replacing existing',async()=>{const test=await setup();await select(test,[file('saved.png')]);test.elements.resultImg.src='/static/gen/result.png';await test.elements.asRefBtn.click();assert.equal(count(test),2);assert.equal(test.elements.refPreview.children[0].children[0].title,'saved.png');assert.equal(test.elements.refPreview.children[1].children[0].title,'生成结果');});
await check('total reference character budget rejects transaction before generation',async()=>{const test=await setup();await select(test,[file('saved.png')]);const large='data:image/png;base64,'+'A'.repeat(1100000);await select(test,Array.from({length:13},(_,index)=>file(index+'.png',large)));assert.equal(count(test),1);assert.match(test.elements.errorText.textContent,/总大小过大/);assert.equal(test.requests.length,0);});
await check('plain text generation omits references while fixed default remains square',async()=>{const test=await setup();await pause();test.elements.prompt.value='text only';await test.elements.generateBtn.click();assert.equal(test.requests[0].size,'1:1');assert.equal('referenceImages' in test.requests[0],false);});
await check('ready performs one metadata prepare and one bound image request',async()=>{const test=await setup({health:{imageReady:true,promptOptimizationReady:true,promptOptimizationMode:'text'}});await pause();assert.equal(test.elements.optimizeToggle.checked,true);await select(test,[file('one.png'),file('two.png')]);await test.elements.sizeChips.children[2].click();test.elements.prompt.value='original <script>';await test.elements.generateBtn.click();assert.equal(test.preparations.length,1);assert.equal(test.requests.length,1);assert.deepEqual(Object.keys(test.preparations[0]).sort(),['prompt','referenceHashes','requestId','size']);const digest=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(png));assert.equal(test.preparations[0].referenceHashes[0],Buffer.from(digest).toString('hex'));assert.equal(test.requests[0].optimizationToken,'test-token');assert.equal(test.requests[0].requestId,test.preparations[0].requestId);assert.match(test.requests[0].requestId,/^[a-f0-9-]{36}$/);assert.equal(test.requests[0].prompt,'original <script>');assert.equal(test.requests[0].size,'auto');assert.equal(test.elements.prompt.value,'original <script>');assert.equal(test.elements.originalPromptDisplay.textContent,'original <script>');assert.equal(test.elements.optimizedPromptDisplay.textContent,'optimized original <script>');assert.equal(test.elements.optimizationDetails.hidden,false);const stored=JSON.parse(test.storage.get('qisao_studio_history'));assert.equal(stored[0].optimizedPrompt,'optimized original <script>');assert.equal('optimizationToken' in stored[0],false);assert.equal('requestId' in stored[0],false);assert.equal('referenceImages' in stored[0],false);});
await check('missing health readiness stays off and skips prepare',async()=>{const test=await setup();await pause();assert.equal(test.elements.optimizeToggle.checked,false);assert.equal(test.elements.optimizeToggle.disabled,true);test.elements.prompt.value='old backend';await test.elements.generateBtn.click();assert.equal(test.preparations.length,0);assert.equal(test.requests.length,1);assert.equal('optimizationToken' in test.requests[0],false);});
await check('explicit nontext mode stays off while missing mode is compatible',async()=>{const disabled=await setup({health:{imageReady:true,promptOptimizationReady:true,promptOptimizationMode:'vision'}});const enabled=await setup({health:{imageReady:true,promptOptimizationReady:true}});await pause();assert.equal(disabled.elements.optimizeToggle.checked,false);assert.equal(enabled.elements.optimizeToggle.checked,true);});
await check('clarification preserves input references and never generates',async()=>{const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async()=>({ok:true,status:200,json:async()=>({status:'needs_clarification',question:'<b>哪一个主体？</b>'})})});await select(test,[file()]);test.elements.prompt.value='question';await test.elements.generateBtn.click();assert.equal(test.requests.length,0);assert.equal(count(test),1);assert.equal(test.elements.prompt.value,'question');assert.equal(test.elements.stageClarification.hidden,false);assert.equal(test.elements.clarificationQuestion.textContent,'<b>哪一个主体？</b>');assert.equal(test.elements.prompt.disabled,false);});
await check('technical fallback requires explicit click and uses unchanged snapshot',async()=>{const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async()=>({ok:false,status:503,json:async()=>({code:'OPTIMIZATION_UNAVAILABLE',allowOriginal:true,error:'service unavailable'})})});await pause();test.elements.prompt.value='fallback original';await test.elements.generateBtn.click();assert.equal(test.requests.length,0);assert.equal(test.elements.useOriginalBtn.hidden,false);await test.elements.useOriginalBtn.click();assert.equal(test.requests.length,1);assert.equal(test.requests[0].prompt,'fallback original');assert.equal('optimizationToken' in test.requests[0],false);assert.notEqual(test.requests[0].requestId,test.preparations[0].requestId);});
await check('fallback is invalidated by edits and checked again without events',async()=>{const setupFallback=async()=>{const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async()=>({ok:false,status:503,json:async()=>({code:'OPTIMIZATION_UNAVAILABLE',allowOriginal:true,error:'unavailable'})})});await pause();test.elements.prompt.value='fallback';await test.elements.generateBtn.click();return test;};const edited=await setupFallback();edited.elements.prompt.value='new demand';await edited.elements.prompt.dispatch('input');assert.equal(edited.elements.useOriginalBtn.hidden,true);await edited.elements.useOriginalBtn.click();assert.equal(edited.requests.length,0);const changed=await setupFallback();changed.elements.prompt.value='without event';await changed.elements.useOriginalBtn.click();assert.equal(changed.requests.length,0);assert.equal(changed.elements.useOriginalBtn.hidden,true);});
await check('safety or unknown HTTP failure never offers original fallback',async()=>{for(const failure of [{status:422,body:{code:'OPTIMIZATION_BLOCKED',allowOriginal:true,error:'blocked'}},{status:503,body:{code:'OTHER',allowOriginal:true,error:'other'}},{status:400,body:{code:'OPTIMIZATION_UNAVAILABLE',allowOriginal:true,error:'bad request'}}]){const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async()=>({ok:false,status:failure.status,json:async()=>failure.body})});await pause();test.elements.prompt.value='safety';await test.elements.generateBtn.click();assert.equal(test.requests.length,0);assert.equal(test.elements.useOriginalBtn.hidden,true);}});
await check('original mismatch stops before image and keeps user text',async()=>{const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async()=>({ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'token',originalPrompt:'wrong',optimizedPrompt:'optimized'})})});await pause();test.elements.prompt.value='correct';await test.elements.generateBtn.click();assert.equal(test.requests.length,0);assert.match(test.elements.errorText.textContent,/不一致/);assert.equal(test.elements.prompt.value,'correct');});
await check('prepare and image pending lock all controls and block duplicate submits without loading clocks',async()=>{let resolvePrepare;const waitPrepare=new Promise(resolve=>{resolvePrepare=resolve;});let resolveImage;const waitImage=new Promise(resolve=>{resolveImage=resolve;});const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async payload=>{await waitPrepare;return {ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'token',originalPrompt:payload.prompt,optimizedPrompt:'optimized'})};},image:async()=>{await waitImage;return {ok:true,status:200,json:async()=>({status:'ok',url:'/result.png'})};}});await pause();assert.equal(test.elements.generateLabel.textContent,'视觉优化并生成');assert.match(test.elements.optimizeStatus.textContent,/保留原意.*构图、光线、色彩与质感/);test.elements.prompt.value='pending';const generation=test.elements.generateBtn.click();await pause();assert.equal(test.preparations.length,1);assert.equal(test.elements.prompt.disabled,true);assert.equal(test.elements.optimizeToggle.disabled,true);assert.equal(test.elements.refInput.disabled,true);assert.equal(test.elements.sizeChips.children[0].disabled,true);assert.equal(test.elements.loadingText.textContent,'正在优化视觉，完成后自动生成…');assert.doesNotMatch(test.elements.loadingText.textContent,/已用|秒|倒计时|%|％/);await test.elements.generateBtn.click();await test.elements.prompt.dispatch('keydown',test.elements.prompt,{key:'Enter',ctrlKey:true});resolvePrepare();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(test.requests.length,1);assert.equal(test.elements.prompt.disabled,true);assert.equal(test.elements.loadingText.textContent,'正在生成并保存…');assert.doesNotMatch(test.elements.loadingText.textContent,/已用|秒|倒计时|%|％/);await test.elements.generateBtn.click();resolveImage();await generation;assert.equal(test.requests.length,1);assert.equal(test.elements.prompt.disabled,false);assert.deepEqual(test.timeoutDurations,[240000]);const stored=JSON.parse(test.storage.get('qisao_studio_history'));assert.equal(typeof stored[0].ts,'number');assert.ok(stored[0].ts>0);});
await check('programmatic input change during prepare never sends a stale image',async()=>{let unblock;const pending=new Promise(resolve=>{unblock=resolve;});const test=await setup({health:{imageReady:true,promptOptimizationReady:true},prepare:async payload=>{await pending;return {ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'token',originalPrompt:payload.prompt,optimizedPrompt:'optimized'})};}});await pause();test.elements.prompt.value='before';const generation=test.elements.generateBtn.click();await pause();test.elements.prompt.value='after';unblock();await generation;assert.equal(test.requests.length,0);assert.equal(test.elements.prompt.value,'after');assert.match(test.elements.errorText.textContent,/已变化/);});
await check('unknown generation outcome requires explicit duplicate charge confirmation',async()=>{const test=await setup({confirm:false,image:async()=>{throw new TypeError('network');}});await pause();test.elements.prompt.value='uncertain';await test.elements.generateBtn.click();assert.equal(test.requests.length,1);assert.match(test.elements.errorText.textContent,/结果尚未确认/);await test.elements.errorRetry.click();assert.equal(test.requests.length,1);assert.equal(test.confirmations.length,1);assert.match(test.confirmations[0],/可能重复计费/);});
await check('legacy generation timeout retains unknown-result protection without a loading clock', async () => {
    let notifyImageStarted;
    const imageStarted = new Promise(resolve => { notifyImageStarted = resolve; });
    const test = await setup({ virtualTimers: true, confirm: false, image: (payload, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        notifyImageStarted();
    }) });
    await pause();
    test.elements.prompt.value = 'image takes too long';
    const generation = test.elements.generateBtn.click();
    await imageStarted;
    assert.deepEqual(test.timeoutDurations, [240000]);
    assert.equal(test.elements.stageLoading.hidden, false);
    assert.doesNotMatch(test.elements.loadingText.textContent, /已用|秒|倒计时|%|％/);
    test.advanceTime(240000);
    await generation;
    assert.equal(test.requests.length, 1);
    assert.equal(test.elements.stageError.hidden, false);
    assert.match(test.elements.errorText.textContent, /结果尚未确认/);
    await test.elements.errorRetry.click();
    assert.equal(test.requests.length, 1);
    assert.equal(test.confirmations.length, 1);
});
await check('prepare remains pending beyond former 30 second deadline and only ready triggers one token-bound generation',async()=>{
    let resolvePrepare;
    const waitPrepare=new Promise(resolve=>{resolvePrepare=resolve;});
    const test=await setup({virtualTimers:true,health:{imageReady:true,promptOptimizationReady:true},prepare:(payload,options)=>new Promise((resolve,reject)=>{
        options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
        waitPrepare.then(()=>resolve({ok:true,status:200,json:async()=>({status:'ready',optimizationToken:'waited-ready-token',originalPrompt:payload.prompt,optimizedPrompt:'optimized after wait'})}));
    })});
    await select(test,[file('first.png'),file('second.png')]);
    await test.elements.sizeChips.children[2].click();
    test.elements.prompt.value='wait for complete optimization';
    const generation=test.elements.generateBtn.click();
    for (let attempt=0; attempt<100 && test.preparations.length===0; attempt++) await pause();
    assert.equal(test.preparations.length,1);
    assert.deepEqual(test.timeoutDurations,[]);
    test.advanceTime(31000);
    await pause();
    assert.equal(test.requests.length,0);
    assert.equal(test.elements.stageLoading.hidden,false);
    assert.equal(test.elements.useOriginalBtn.hidden,true);
    assert.equal(test.elements.generateBtn.disabled,true);
    assert.equal(test.elements.loadingText.textContent,'正在优化视觉，完成后自动生成…');
    await test.elements.generateBtn.click();
    assert.equal(test.preparations.length,1);
    resolvePrepare();
    await generation;
    assert.equal(test.requests.length,1);
    assert.equal(test.requests[0].optimizationToken,'waited-ready-token');
    assert.equal(test.requests[0].requestId,test.preparations[0].requestId);
    assert.equal(test.requests[0].prompt,'wait for complete optimization');
    assert.equal(test.requests[0].size,'auto');
    assert.deepEqual(test.requests[0].referenceImages,[png,png]);
    assert.deepEqual(test.timeoutDurations,[240000]);
});
console.log(JSON.stringify({mockOnly:true,providerCalls:0,checks:checks.length,passed:checks.filter(check=>check.passed).length,failures:checks.filter(check=>!check.passed)},null,2));
if(checks.some(check=>!check.passed))process.exitCode=1;
