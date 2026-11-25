// A log entry is an append operation. Only the consumer needs a notification.
export function createDisplayLogQueue() {
 let pending = [];
 let consumer;
 let scheduled = false;
 let closed = false;
 function schedule() {
  if (!consumer || scheduled || !pending.length) return;
  scheduled = true;
  queueMicrotask(() => {
   scheduled = false;
   if (!consumer) return;
   const batch = pending;
   pending = [];
   for (const entry of batch) consumer(entry);
  });
 }
 return {
  append(entry) { if (!closed) { pending.push(entry); schedule(); } },
  listen(fn) { consumer = fn; schedule(); },
  close() { closed = true; consumer = undefined; pending = []; },
 };
}
