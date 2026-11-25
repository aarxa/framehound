// Plays Edelweiss (github.com/felixmariotto/Edelweiss, CC0) between capture moments: starts a solo game once the
// assets have loaded, then walks and jumps at random. The game streams its models from the author's public bucket.
const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));

export async function start(page) {
  for (let i = 0; i < 90; i++) {
    const menuGone = await page.evaluate(() => {
      const m = document.getElementById('start-menu');
      return !m || getComputedStyle(m).display === 'none' || getComputedStyle(m).visibility === 'hidden';
    });
    if (menuGone) break;
    await page.click('#start-button').catch(() => {});
    await sleep(1);
  }
  await sleep(3);
}

export async function between(page, gap) {
  const end = Date.now() + gap * 1000;
  while (Date.now() < end) {
    const key = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'][Math.floor(Math.random() * 6)];
    await page.keyboard.down(key);
    if (Math.random() < 0.4) await page.keyboard.press('Space');
    await sleep(0.3 + Math.random() * 0.7);
    await page.keyboard.up(key);
  }
}
