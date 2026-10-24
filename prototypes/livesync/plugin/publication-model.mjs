export const MAX_PUBLICATION_BYTES=32*1024*1024;
export const publicationTypes={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif',mp4:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',wav:'audio/wav',pdf:'application/pdf'};
export async function publicationHash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export function publicationAttribute(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function publicationEmbed(asset,embedded,label){
 const key=publicationAttribute(asset.key),name=publicationAttribute(label||asset.filename),type=publicationTypes[asset.filename.split('.').pop().toLowerCase()];
 if(embedded&&type.startsWith('image/'))return `<img src="https://arcalink.ru/pending-publication-assets/${key}" alt="${name}">`;
 if(embedded&&(type.startsWith('video/')||type.startsWith('audio/'))){const tag=type.startsWith('video/')?'video':'audio';return `<${tag} src="https://arcalink.ru/pending-publication-assets/${key}" controls></${tag}>`;}
 return `<a href="https://arcalink.ru/pending-publication-assets/${key}">${name}</a>`;
}
export function replacePublicationLinks(markdown,replacements){
 let end=markdown.length;
 for(const r of [...replacements].sort((a,b)=>b.start-a.start)){
  if(r.end>end||markdown.slice(r.start,r.end)!==r.original)throw Error('Заметка изменилась. Откройте публикацию заново.');
  markdown=markdown.slice(0,r.start)+r.html+markdown.slice(r.end);end=r.start;
 }
 return markdown;
}
