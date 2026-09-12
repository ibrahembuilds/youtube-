// Minimal test harness.
//
// A check can be tagged with a finding id it is known to fail (`known: "F04"`).
// That keeps the suite green on today's codebase while still documenting the
// open bugs, and it fails loudly in two directions:
//   - an untagged check that fails  -> a regression
//   - a tagged check that passes    -> the bug is fixed, drop the tag
// Only regressions set a non-zero exit code.

const results = [];
let currentGroup = "";

export function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

export function check(name, passed, detail = "", known = null) {
  const status = passed
    ? known ? "FIXED" : "PASS"
    : known ? "KNOWN" : "FAIL";
  const colour = { PASS: 32, FAIL: 31, KNOWN: 33, FIXED: 36 }[status];
  const tag = known ? ` [${known}]` : "";
  console.log(`  \x1b[${colour}m${status.padEnd(5)}\x1b[0m ${name}${tag}`);
  if (detail && status !== "PASS") console.log(`        ${String(detail).replace(/\n/g, "\n        ")}`);
  results.push({ group: currentGroup, name, status, detail, known });
  return passed;
}

export function summarise(label) {
  const by = (s) => results.filter((r) => r.status === s);
  const regressions = by("FAIL");
  const fixed = by("FIXED");

  console.log("\n" + "─".repeat(66));
  console.log(
    `${label}: ${by("PASS").length} pass · ${regressions.length} fail · ` +
    `${by("KNOWN").length} known-issue · ${fixed.length} newly-fixed`
  );
  console.log("─".repeat(66));

  if (fixed.length) {
    console.log("\nNewly passing — remove the known-issue tag:");
    for (const r of fixed) console.log(`  ${r.known}  ${r.name}`);
  }
  if (regressions.length) {
    console.log("\nRegressions:");
    for (const r of regressions) console.log(`  ✗ ${r.name}\n      ${r.detail}`);
  }
  process.exitCode = regressions.length ? 1 : 0;
  return results;
}

export async function serverIsUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

export function requireServer(up, hint) {
  if (up) return;
  console.error(`\n\x1b[31mCannot reach the dev server.\x1b[0m Start it first:\n  ${hint}\n`);
  process.exit(2);
}
