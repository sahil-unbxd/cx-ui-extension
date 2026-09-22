/** Loads SKILLS.md (shipped inside the extension) and hands the prompt builder
 *  just the section for the issue type being debugged. The whole file is never
 *  injected — that is what the per-type `## ` headings are for. */

let cache = null;

async function loadSkills() {
  if (cache) return cache;
  const res = await fetch(chrome.runtime.getURL('SKILLS.md'));
  cache = await res.text();
  return cache;
}

/** Returns the body of the `## <heading>` section, minus its own heading. */
export async function getSkillSection(heading) {
  const text = await loadSkills();
  const lines = text.split('\n');
  const start = lines.findIndex(
    (l) => l.startsWith('## ') && l.slice(3).trim().toLowerCase() === heading.trim().toLowerCase()
  );
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}
