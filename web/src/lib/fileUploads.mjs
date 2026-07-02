import { apiErrorMessage } from './apiRequest.mjs';

export function uploadMessage(error) {
  const detail = error?.error || error?.message || error;
  return apiErrorMessage(typeof detail === 'string' ? detail : '', 'upload failed');
}

export async function runUploadBatch(files = [], {
  host,
  cwd,
  records = [],
  onRecords = () => {},
  toast = () => {},
  uploadFile,
} = {}) {
  if (typeof uploadFile !== 'function') throw new Error('uploadFile is required');
  let nextRecords = [...records];
  let changed = false;
  let failed = 0;
  const setRecords = (next) => {
    nextRecords = next;
    onRecords(nextRecords);
  };

  for (const file of files) {
    const rec = { name: file.name || 'upload', pct: 0, error: false, message: '' };
    setRecords([...nextRecords, rec]);
    try {
      const result = await uploadFile(host, cwd, file, (progress) => {
        rec.pct = Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
        setRecords([...nextRecords]);
      });
      if (result && result.ok) {
        changed = true;
        setRecords(nextRecords.filter((item) => item !== rec));
      } else {
        failed += 1;
        rec.error = true;
        rec.message = uploadMessage(result);
        setRecords([...nextRecords]);
        toast('Upload failed: ' + rec.name);
      }
    } catch (e) {
      failed += 1;
      rec.error = true;
      rec.message = uploadMessage(e);
      setRecords([...nextRecords]);
      toast('Upload failed: ' + rec.name);
    }
  }

  return { changed, failed, records: nextRecords };
}
