import { hashFile } from './hash';

/** One file per worker; 2 MiB reads keep memory bounded even for multi-gigabyte inputs. */
self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  const { file } = event.data;
  try {
    const sha256 = await hashFile(file, bytes => self.postMessage({ bytes }));
    self.postMessage({ bytes: file.size, sha256 });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '无法读取文件以完成校验。' });
  }
};
