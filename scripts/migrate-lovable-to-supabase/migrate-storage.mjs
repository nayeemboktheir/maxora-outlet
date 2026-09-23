// Copies public Lovable Storage objects to the target. Re-runnable: an object
// at the same path and byte size is skipped. Run only after DB import succeeds.
import { createClient } from '@supabase/supabase-js';

const required = ['SOURCE_URL', 'SOURCE_ANON_KEY', 'TARGET_URL', 'TARGET_SERVICE_KEY', 'BUCKET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const source = createClient(process.env.SOURCE_URL, process.env.SOURCE_ANON_KEY);
const target = createClient(process.env.TARGET_URL, process.env.TARGET_SERVICE_KEY);
const bucket = process.env.BUCKET;

async function retry(label, operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await operation();
      if (result?.error) throw result.error;
      return result?.data ?? result;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = attempt * 2000;
      console.warn(`${label} failed (attempt ${attempt}/${attempts}); retrying in ${delay / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function allFiles(path = '') {
  const { data, error } = await source.storage.from(bucket).list(path, { limit: 1000 });
  if (error) throw error;
  const nested = await Promise.all(data.map(async item => {
    const full = path ? `${path}/${item.name}` : item.name;
    return item.metadata ? [{ path: full, metadata: item.metadata }] : allFiles(full);
  }));
  return nested.flat();
}

// Maxora's known Lovable bucket is public. Some Storage API versions throw on
// getBucket(unknown) instead of returning { data: null }, so handle that
// expected target-empty state explicitly.
const sourceBucket = { public: true, file_size_limit: null, allowed_mime_types: null };
let targetBucket = null;
try {
  ({ data: targetBucket } = await target.storage.getBucket(bucket));
} catch (error) {
  if (error?.statusCode !== '404') throw error;
}
if (!targetBucket) {
  const { error } = await target.storage.createBucket(bucket, {
    public: sourceBucket.public,
    fileSizeLimit: sourceBucket.file_size_limit,
    allowedMimeTypes: sourceBucket.allowed_mime_types,
  });
  if (error) throw error;
}

const files = await allFiles();
let copied = 0, skipped = 0;
for (const file of files) {
  const { data: existing } = await target.storage.from(bucket).list(file.path.split('/').slice(0, -1).join('/'), { limit: 1000 });
  const found = existing?.find(x => x.name === file.path.split('/').at(-1));
  if (found?.metadata?.size === file.metadata?.size) { skipped++; continue; }
  const data = await retry(`download ${file.path}`, () => source.storage.from(bucket).download(file.path));
  await retry(`upload ${file.path}`, () => target.storage.from(bucket).upload(file.path, data, {
    upsert: true, contentType: file.metadata?.mimetype, cacheControl: file.metadata?.cacheControl,
  }));
  copied++;
  console.log(`copied ${file.path}`);
}
console.log(`Storage complete: ${copied} copied, ${skipped} already present, ${files.length} total.`);
