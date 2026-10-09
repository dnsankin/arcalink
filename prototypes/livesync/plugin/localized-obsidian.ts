// This alias is externalised to the real Obsidian module by the pilot build.
export * from 'arcalink-native-obsidian';
import {Notice as NativeNotice,Modal as NativeModal,Plugin as NativePlugin,getLanguage,type Command} from 'arcalink-native-obsidian';
import {allMessages} from './common/messages/combinedMessages.prod';
import extraMessages from './message-catalog.mjs';
import {createMessageTranslator} from './message-language.mjs';
import {createNoticeFormatter} from './notice-message.mjs';
const translate=createMessageTranslator({...allMessages,...Object.fromEntries(Object.entries(extraMessages).map(([key,entry])=>[key,{...(allMessages as any)[key],...entry}]))});
let languageSource:(()=>string|undefined)|undefined;
export function setMessageLanguageSource(source?:()=>string|undefined){languageSource=source;}
export function messageLanguage(){
  try{const selected=languageSource?.();if(selected)return selected;}catch{/* Settings may still be loading. */}
  try{return getLanguage();}catch{return localStorage.getItem('language')||'en';}
}
export function localizeMessage(message:string){return translate(message,messageLanguage());}
const formatNotice=createNoticeFormatter(translate);
export class Plugin extends NativePlugin {
  override addCommand(command:Command){return super.addCommand({...command,name:localizeMessage(command.name)});}
}
function localizeNodes(root:Node,notification=false){
  const walker=root.ownerDocument!.createTreeWalker(root,4);
  while(walker.nextNode()){
    const node=walker.currentNode as Text;
    if(node.parentElement?.closest('pre,code,input,textarea,[data-arcalink-user-content]'))continue;
    const interactive=node.parentElement?.closest('button,a,select,option');
    const managedText=node.parentElement?.matches('.vpk-keyed-notice,.vpk-keyed-notice-group__message')===true;
    // Text fragments retain the spacing around action links and inline elements.
    const body=node.data.trim();
    if(!body)continue;
    const value=notification&&!interactive?node.data.replace(body,()=>formatNotice(body,messageLanguage(),{allowFallback:managedText})):localizeMessage(node.data);
    if(value!==node.data){
      if(notification&&value!==localizeMessage(node.data))console.debug('[ArcaLink notification details]',node.data);
      node.data=value;
    }
  }
  if(root.nodeType===1)for(const element of (root as Element).querySelectorAll('[title],[placeholder],[aria-label]')){
    if(element.closest('[data-arcalink-user-content]'))continue;
    for(const attribute of ['title','placeholder','aria-label']){
      const original=element.getAttribute(attribute);if(original===null)continue;
      const value=localizeMessage(original);if(value!==original)element.setAttribute(attribute,value);
    }
  }
}
export function observeLocalizedUI(root:HTMLElement){
  localizeNodes(root);
  const observer=new MutationObserver(()=>localizeNodes(root));
  observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label']});
  return ()=>observer.disconnect();
}
function localizeNotice(message:string|DocumentFragment){
  if(typeof message==='string'){
    const friendly=formatNotice(message,messageLanguage());
    if(friendly!==localizeMessage(message))console.debug('[ArcaLink notification details]',message);
    return friendly;
  }
  localizeNodes(message,true);return message;
}
export class Notice extends NativeNotice {
  private languageObserver?:MutationObserver;
  constructor(message:string|DocumentFragment,timeout?:number){
    super(localizeNotice(message),timeout);
    // Grouped/keyed notices render into their retained DOM after construction.
    const root=this.noticeEl;
    this.languageObserver=new MutationObserver(()=>localizeNodes(root,true));
    this.languageObserver.observe(root,{subtree:true,childList:true,characterData:true});
  }
  override setMessage(message:string|DocumentFragment){super.setMessage(localizeNotice(message));return this;}
  override hide(){this.languageObserver?.disconnect();super.hide();}
}
export class Modal extends NativeModal {
  private languageObserver?:MutationObserver;
  override open(){
    super.open();localizeNodes(this.contentEl);localizeNodes(this.titleEl);
    this.languageObserver?.disconnect();
    this.languageObserver=new MutationObserver(()=>{localizeNodes(this.contentEl);localizeNodes(this.titleEl);});
    this.languageObserver.observe(this.modalEl,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label']});
  }
  override close(){this.languageObserver?.disconnect();super.close();}
}
