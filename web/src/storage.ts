export interface UploadRecord {
  id: string; owner: string; relativePath: string; name: string; size: number; lastModified: number;
  fingerprint: string; uploadUrl?: string; sha256?: string;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ftp-web-uploads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('uploads', mode);
    const request = action(transaction.objectStore('uploads'));
    transaction.oncomplete = () => { database.close(); resolve(request.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}
export async function readRecords(owner: string) { return (await transact('readonly', store => store.getAll()) as UploadRecord[]).filter(record => record.owner === owner); }
export async function saveRecord(record: UploadRecord) { await transact('readwrite', store => store.put(record)); }
export async function deleteRecord(id: string) { await transact('readwrite', store => store.delete(id)); }
