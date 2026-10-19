import {Modal,Setting} from 'obsidian';
import {localizeMessage,messageInEnglish,messageLanguage} from './localized-obsidian';
import {createNoticeFormatter} from './notice-message.mjs';
import {mobileSyncState} from './mobile-sync-state.mjs';

/** Mobile view only; receives the desktop lamp's already-read snapshot. */
export function createMobileSyncStatus(pilot:any){
 let disposed=false,hasSnapshot=false,snapshot:any={},dialog:Details|null=null;
 const button=document.createElement('button');button.className='arcalink-mobile-sync-status';button.type='button';
 button.createSpan({cls:'arcalink-mobile-sync-dot',attr:{'aria-hidden':'true'},text:'●'});
 const label=button.createSpan({cls:'arcalink-mobile-sync-label'});
 const counters=button.createSpan({cls:'arcalink-mobile-sync-counts',attr:{'aria-hidden':'true'}});
 const format=createNoticeFormatter((text:string,language:string)=>language==='en'?messageInEnglish(text):localizeMessage(text));
 const readable=(value:string)=>{
  const friendly=format(value,messageLanguage());
  return /https?:\/\/|\b(?:TypeError|SyntaxError|ReferenceError|HTTP|Exception)\b|\[StackTrace\]/.test(friendly)||friendly.length>400
   ?localizeMessage('Не удалось подтвердить синхронизацию. Откройте настройки ArcaLink.'):friendly;
 };
 const model=()=>mobileSyncState(snapshot);
 const mount=()=>{
  if(disposed||!hasSnapshot)return;
  const view=pilot.app.workspace.getMostRecentLeaf()?.view;
  if(view?.getViewType()!=='markdown'){button.remove();return;}
  const root=view.containerEl;if(!root?.isConnected){button.remove();return;}
  const header=root.querySelector(':scope > .view-header');
  const next=header?.nextSibling||root.firstChild;
  if(button.parentElement!==root)root.insertBefore(button,next);
 };
 const render=()=>{
  if(disposed)return;
  const state=model();button.dataset.state=state.kind;
  const text=localizeMessage(state.label);if(label.textContent!==text)label.setText(text);
  counters.setText(state.counters?'↑ '+state.counters.sent+'  ↓ '+state.counters.arrived:'');
  button.setAttribute('aria-label','ArcaLink: '+text+'. '+localizeMessage('Открыть статус синхронизации'));
  button.title=localizeMessage('Открыть статус синхронизации');
  mount();dialog?.render();
 };
 class Details extends Modal {
  status!:HTMLElement;description!:HTMLElement;counts!:HTMLElement;hint!:HTMLElement;reason!:HTMLElement;
  override onOpen(){
   this.titleEl.setText(localizeMessage('Статус синхронизации'));
   this.status=this.contentEl.createEl('h3',{attr:{'aria-live':'polite'}});
   this.description=this.contentEl.createEl('p');this.counts=this.contentEl.createEl('p');this.hint=this.contentEl.createEl('p');this.reason=this.contentEl.createEl('p');
   new Setting(this.contentEl).addButton(b=>b.setButtonText('Настройки синхронизации').onClick(()=>{this.close();pilot.pilotSettingsTab='sync';pilot.openMobileSyncSettings();}));
   this.render();
  }
  render(){
   const state=model(),status=localizeMessage(state.label);if(this.status.textContent!==status)this.status.setText(status);this.description.setText(localizeMessage(state.detail));
   this.counts.hidden=!state.counters;this.hint.hidden=!state.counters;
   this.counts.setText(state.counters?localizeMessage('Передача за сеанс')+': ↑ '+state.counters.sent+'  ↓ '+state.counters.arrived:'');
   this.hint.setText(localizeMessage('Это счётчики обмена данными, а не количество полностью синхронизированных файлов.'));
   this.reason.setText(state.kind==='error'?[...new Set<string>((snapshot.errors||[]).map((value:any)=>readable(String(value))))].slice(0,2).join('\n'):'');
   this.reason.hidden=!this.reason.textContent;
  }
  override onClose(){dialog=null;this.contentEl.empty();}
 }
 const open=()=>{if(disposed||dialog)return;dialog=new Details(pilot.app);dialog.open();};
 button.addEventListener('click',open);
 pilot.registerEvent(pilot.app.workspace.on('active-leaf-change',mount));
 pilot.registerEvent(pilot.app.workspace.on('layout-change',mount));
 return {update(next:any){if(!disposed){snapshot=next;hasSnapshot=true;try{render();}catch(error){console.warn('ArcaLink mobile status display failed',error);button.remove();}}},dispose(){if(disposed)return;disposed=true;dialog?.close();button.removeEventListener('click',open);button.remove();}};
}
