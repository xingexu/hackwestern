import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({
  options: { 'world-dir': { type: 'string' }, standalone: { type: 'string' }, 'shot-prefix': { type: 'string' } }
});
const cli = process.env.PATH.split(delimiter).map(directory => join(directory, 'playwright')).find(existsSync);
assert.ok(cli, "Run via npm exec --yes --package=playwright@1.65.1 -c 'node dev/verify_browser.mjs'.");
const { chromium } = await import(pathToFileURL(resolve(realpathSync(cli), '../index.mjs')));
const stage = await mkdtemp(join(root, 'dev', 'verify-'));
const shots = join(root, 'dev', 'shots');
const prefix = values['shot-prefix'] ?? 'test';
const viewport = { width: 1440, height: 900 };
let browser;
let server;

async function runServer(directory) {
  server=spawn(process.execPath,[resolve(root,'../serve.mjs'),'--port','0','--root',directory],{stdio:['ignore','pipe','inherit']});
  const [startup]=await once(server.stdout,'data');
  const address=startup.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  return address+'/?diagnostics&view=overview';
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function load(page, url) {
  const failures=[];
  page.on('requestfailed',request=>failures.push(request.url()+' '+request.failure()?.errorText));
  await page.goto(url, { waitUntil: 'load' });
  const result = await page.waitForFunction(() => {
    if (window.campusMetrics?.triangles > 0 && document.querySelector('#status')?.hidden === true) return 'ready';
    return document.querySelector('#status[role="alert"]')?.textContent || false;
  }, undefined, { timeout: 15000 });
  const state=await result.jsonValue();
  assert.equal(state,'ready',[state,...failures].join('\n'));
  assert.ok(await page.locator('#view').evaluate(canvas => canvas.getContext('webgl2')));
}

const canvasShot = page => page.locator('#view').screenshot({
  style: 'header, #controls, #scale-panel, #reset, #labels { visibility: hidden !important; }'
});
const screenshot = (page, name) => page.screenshot({ path: join(shots, `${prefix}-${name}.png`) });

async function checkCoverage(page) {
  const holes=await page.evaluate(()=>window.campusMetrics.countUncovered(420,315,600,300));
  assert.equal(holes,0,'Every pixel in the central terrain region should have scene depth.');
}

async function checkDefaultView(url, hasCourse) {
  const page = await browser.newPage({ viewport });
  const errors = watchErrors(page);
  await load(page, url);
  await page.waitForFunction(() => window.campusMetrics.fps > 0);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#labels .tag')]
    .filter(tag => !tag.hidden)
    .map(tag => tag.querySelector('canvas').textContent));
  for (const name of ['University College', 'Middlesex College']) {
    assert.ok(shown.includes(name), `The default view should open on UC Hill with ${name} labelled, saw ${shown.join(', ')}`);
  }
  await page.screenshot({ path: join(shots, `${prefix}-default.png`) });
  if (hasCourse) {
    assert.equal(await page.locator('#scale-value').textContent(), '1×');
    const bounds = await page.evaluate(() => window.campusMetrics.bounds);
    assert.deepEqual(bounds,JSON.parse(await readFile(join(root,'campus-boundary.json'))).bounds);
    const near = await canvasShot(page);
    await page.getByRole('button', { name: 'Entire campus' }).click();
    await page.waitForFunction(() => !document.querySelector('.tag:not([hidden])'));
    const wide = await canvasShot(page);
    assert.ok(!near.equals(wide));
    await screenshot(page, 'entire-campus');
    await page.getByRole('button', { name: 'Reset map view' }).click();
    await page.waitForFunction(() => document.querySelector('.tag:not([hidden])'));
    await page.getByRole('link', { name: 'Drive UC Hill' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'drive' && document.querySelector('#status')?.hidden === true);
    await page.keyboard.down('w');
    await page.waitForFunction(() => Number(document.querySelector('#speed').textContent) > 20);
    await page.keyboard.up('w');
  }
  assert.deepEqual(errors, []);
  await page.close();
}

async function orbitFps(page) {
  const { width, height } = viewport;
  const sample = () => page.evaluate(() => [performance.now(), window.campusMetrics.frameCount]);
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.down();
  const [start, first] = await sample();
  for (let step = 1; step <= 60; step++) {
    await page.mouse.move(width / 2 + step * 5, height / 2);
    await delay(20);
  }
  const [end, last] = await sample();
  await page.mouse.up();
  await page.getByRole('button', { name: 'Reset map view' }).click();
  return Math.round((last - first) * 1000 / (end - start));
}

async function controls(page) {
  const arrow = page.locator('#north');
  const initialAngle = await arrow.evaluate(element => element.style.transform);
  const initialImage = await canvasShot(page);
  const initialDrawCalls = await page.evaluate(() => window.campusMetrics.steadyDrawCalls);

  await page.keyboard.press('e');
  await page.waitForFunction(angle => document.querySelector('#north').style.transform !== angle, initialAngle);
  await screenshot(page, 'rotation-2');
  await checkCoverage(page);
  assert.ok(!(await canvasShot(page)).equals(initialImage), 'Keyboard rotation must change the canvas.');

  const scale = page.getByRole('slider', { name: 'Pixel size' });
  await scale.press('End');
  assert.equal(await page.locator('#scale-value').textContent(), '6×');
  await scale.press('Home');
  assert.equal(await page.locator('#scale-value').textContent(), '1×');
  await scale.press('ArrowRight');
  assert.equal(await page.locator('#scale-value').textContent(), '2×');
  await scale.press('ArrowRight');

  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, -690);
  await page.waitForFunction(() => document.querySelector('.tag:not([hidden])'));
  await screenshot(page, 'detail');
  const detailDrawCalls = await page.evaluate(() => window.campusMetrics.steadyDrawCalls);
  assert.ok(detailDrawCalls < initialDrawCalls, 'Zooming in should cull offscreen chunks.');
  const beforePan = await canvasShot(page);
  const beforeDragAngle = await arrow.evaluate(element => element.style.transform);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(viewport.width / 2 + 115, viewport.height / 2 + 55, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  assert.ok(!(await canvasShot(page)).equals(beforePan), 'Right-drag must move the map.');
  assert.equal(await arrow.evaluate(element => element.style.transform), beforeDragAngle);

  const afterPan = await canvasShot(page);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(viewport.width / 2 + 65, viewport.height / 2 + 25, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.ok(!(await canvasShot(page)).equals(afterPan), 'Shift-drag must move the map.');
  assert.equal(await arrow.evaluate(element => element.style.transform), beforeDragAngle);

  await page.mouse.down();
  await page.mouse.move(viewport.width / 2 - 40, viewport.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  assert.notEqual(await arrow.evaluate(element => element.style.transform), beforeDragAngle);
  await page.getByRole('button', { name: 'Reset map view' }).click();
  await page.waitForFunction(angle => document.querySelector('#north').style.transform === angle, initialAngle);
  assert.equal(await page.locator('.tag:not([hidden])').count(), 0);
  return detailDrawCalls;
}

async function touchControls(url) {
  const touch = await browser.newPage({ viewport: { width: 430, height: 840 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = watchErrors(touch);
  await load(touch, url);
  const input = await touch.context().newCDPSession(touch);
  await input.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: 180, y: 415, id: 1 }, { x: 240, y: 415, id: 2 }]
  });
  await input.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: 75, y: 415, id: 1 }, { x: 345, y: 415, id: 2 }]
  });
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.waitForFunction(() => document.querySelector('.tag:not([hidden])'));
  assert.deepEqual(errors, []);
  await touch.close();
}

try {
  const world = values['world-dir'] ? resolve(values['world-dir']) : join(root, 'dev', 'test-world');
  if (!values['world-dir']) execFileSync(process.execPath, [join(root, 'dev', 'make_test_world.mjs')], { stdio: 'inherit' });
  await mkdir(shots, { recursive: true });
  if (world !== root) {
    await Promise.all([
      ...['index.html', 'main.js', 'mesh-worker.js', 'drive.css', 'three.module.js', 'look'].map(name => symlink(join(root, name), join(stage, name))),
      ...['world.json', 'world.bin'].map(name => symlink(join(world, name), join(stage, name)))
    ]);
  }
  const offline = values.standalone ? resolve(values.standalone) : join(stage, 'campus.html');
  if (!values.standalone) {
    execFileSync(process.execPath, [join(root, 'build_single.mjs'), '--world-dir', world, '--output', offline], { stdio: 'inherit' });
  }

  const url = await runServer(world === root ? root : stage);
  browser = await chromium.launch(process.platform === 'darwin' ? { args: ['--use-angle=metal'] } : {});
  const page = await browser.newPage({ viewport });
  const errors = watchErrors(page);
  await load(page, url);
  await page.waitForFunction(() => window.campusMetrics.fps > 0);
  const first = await screenshot(page, 'rotation-1');
  const initialCanvas = await canvasShot(page);
  await checkCoverage(page);
  const metrics = await page.evaluate(() => {
    const gl = document.querySelector('#view').getContext('webgl2');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { ...window.campusMetrics, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  console.log('HTTP metrics ' + JSON.stringify(metrics));
  metrics.detailDrawCalls = await controls(page);
  metrics.orbitFps = await orbitFps(page);
  console.log('Desktop controls and screenshot coverage passed.');
  await touchControls(url);
  console.log('Touch controls passed.');
  assert.deepEqual(errors, []);
  assert.ok(first.length > 20000);
  await page.close();

  await checkDefaultView(url.replace('&view=overview', ''), world === root);
  console.log('Default UC Hill view passed.');

  const file = await browser.newPage({ viewport, offline: true });
  const externalRequests = [];
  file.on('request', request => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });
  const fileErrors = watchErrors(file);
  await load(file, `${pathToFileURL(offline).href}?diagnostics&view=overview`);
  assert.ok((await canvasShot(file)).equals(initialCanvas), 'Offline and HTTP canvases should render identically.');
  assert.deepEqual(fileErrors, []);
  assert.deepEqual(externalRequests, []);
  const fileMetrics = await file.evaluate(() => ({ ...window.campusMetrics }));
  console.log(JSON.stringify({ http: metrics, file: fileMetrics, screenshots: shots }));
  console.log('Verified WebGL2 rendering, rotation, zoom, labels, pan, reset, pixel scale, touch pinch, and an identical offline file render with zero external requests or console errors.');
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.pid) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(stage, { recursive: true, force: true });
}
