// Plays HexGL (github.com/BKcore/HexGL, MIT) between capture moments: through the menus, then full throttle with
// random steering. The page is opened with godmode on, so the ship can't be destroyed and the race keeps going.
const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));

export async function start(page) {
  await page.click('#start');
  await sleep(0.5);
  await page.click('#step-2'); // the controls help screen; clicking it loads the track
  await page.waitForFunction(() => document.getElementById('step-4')?.style.display === 'block', null, { timeout: 60000 });
  await sleep(5); // countdown
  await page.keyboard.down('ArrowUp');
}

// The race ends after three laps, or early if the ship ends up driving the wrong way; then start a new one.
async function restartIfOver(page) {
  const over = await page.evaluate(() => !window.hexGL?.active || window.hexGL?.gameplay?.step === 100);
  if (!over) return;
  await page.keyboard.up('ArrowUp');
  await page.reload({ waitUntil: 'load' });
  await sleep(3);
  await start(page);
}

export async function between(page, gap) {
  await restartIfOver(page);
  const end = Date.now() + gap * 1000;
  while (Date.now() < end) {
    const r = Math.random();
    const key = r < 0.35 ? 'ArrowLeft' : r < 0.7 ? 'ArrowRight' : null;
    if (key) await page.keyboard.down(key);
    await sleep(0.15 + Math.random() * 0.5);
    if (key) await page.keyboard.up(key);
  }
  await restartIfOver(page);
}
