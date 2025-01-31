import * as common from './common.mjs';
import {
    Vector2, Vector3, Scene, Player,
    sceneGetTile, updatePlayer,
    PLAYER_SIZE, SERVER_PORT,
    clamp, properMod
} from './common.mjs';

const NEAR_CLIPPING_PLANE = 0.1;
const FAR_CLIPPING_PLANE = 10.0;
const FOV = Math.PI*0.5;

const SCREEN_FACTOR = 30;
const SCREEN_WIDTH = Math.floor(16*SCREEN_FACTOR);
const SCREEN_HEIGHT = Math.floor(9*SCREEN_FACTOR);

const ITEM_FREQ = 0.7;
const ITEM_AMP = 0.07;

const BOMB_PARTICLE_COUNT = 50

const PARTICLE_LIFETIME = 1.0;
const PARTICLE_DAMP = 0.8;
const PARTICLE_SCALE = 0.05;
const PARTICLE_MAX_SPEED = 8;

const MINIMAP = false;
const MINIMAP_SPRITES = true;
const MINIMAP_SPRITE_SIZE = 0.2;
const MINIMAP_SCALE = 0.07;

const SPRITE_ANGLES_COUNT = 8;

const CONTROL_KEYS: {[key: string]: common.Moving} = {
    'ArrowLeft'  : common.Moving.TurningLeft,
    'ArrowRight' : common.Moving.TurningRight,
    'ArrowUp'    : common.Moving.MovingForward,
    'ArrowDown'  : common.Moving.MovingBackward,
    'KeyA'       : common.Moving.TurningLeft,
    'KeyD'       : common.Moving.TurningRight,
    'KeyW'       : common.Moving.MovingForward,
    'KeyS'       : common.Moving.MovingBackward,
};

interface SpritePool {
    items: Array<Sprite>,
    length: number,
}

function createSpritePool(): SpritePool {
    return {
        items: [],
        length: 0,
    }
}

function resetSpritePool(spritePool: SpritePool) {
    spritePool.length = 0;
}

function strokeLine(ctx: CanvasRenderingContext2D, p1: Vector2, p2: Vector2) {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
}

interface Camera {
    position: Vector2;
    direction: number;
    fovLeft: Vector2;
    fovRight: Vector2;
}

function renderMinimap(wasmCommon: common.WasmCommon, ctx: CanvasRenderingContext2D, camera: Camera, player: Player, scene: Scene, spritePool: SpritePool, visibleSprites: Array<Sprite>) {
    ctx.save();

    // A couple of temporary vectors
    const p1 = new Vector2();
    const p2 = new Vector2();

    const cellSize = ctx.canvas.width*MINIMAP_SCALE;

    ctx.translate(ctx.canvas.width*0.03, ctx.canvas.height*0.03);
    ctx.scale(cellSize, cellSize);

    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, scene.width, scene.height);

    ctx.lineWidth = 0.05;
    const walls = new Uint8ClampedArray(wasmCommon.memory.buffer, scene.wallsPtr, scene.width*scene.height);
    for (let y = 0; y < scene.height; ++y) {
        for (let x = 0; x < scene.width; ++x) {
            if (sceneGetTile(walls, scene, p1.set(x, y))) {
                ctx.fillStyle = "blue";
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }

    // Grid
    ctx.strokeStyle = "#303030";
    for (let x = 0; x <= scene.width; ++x) {
        strokeLine(ctx, p1.set(x, 0), p2.set(x, scene.height));
    }
    for (let y = 0; y <= scene.height; ++y) {
        strokeLine(ctx, p1.set(0, y), p2.set(scene.width, y));
    }

    ctx.fillStyle = "magenta";
    ctx.fillRect(player.position.x - PLAYER_SIZE*0.5,
                 player.position.y - PLAYER_SIZE*0.5,
                 PLAYER_SIZE, PLAYER_SIZE);

    ctx.strokeStyle = "magenta";
    strokeLine(ctx, camera.fovLeft, camera.fovRight);
    strokeLine(ctx, camera.position, camera.fovLeft);
    strokeLine(ctx, camera.position, camera.fovRight);

    if (MINIMAP_SPRITES) {
        ctx.strokeStyle = "yellow";
        ctx.fillStyle = "white"
        for (let i = 0; i < spritePool.length; ++i) {
            const sprite = spritePool.items[i];
            ctx.fillRect(sprite.position.x - MINIMAP_SPRITE_SIZE*0.5,
                         sprite.position.y - MINIMAP_SPRITE_SIZE*0.5,
                         MINIMAP_SPRITE_SIZE, MINIMAP_SPRITE_SIZE);

        }

        const sp = new Vector2();
        for (let sprite of visibleSprites) {
            strokeLine(ctx, player.position, sprite.position);
            sp.copy(sprite.position).sub(player.position).norm().scale(sprite.dist).add(player.position);
            ctx.fillRect(sp.x - MINIMAP_SPRITE_SIZE*0.5,
                         sp.y - MINIMAP_SPRITE_SIZE*0.5,
                         MINIMAP_SPRITE_SIZE, MINIMAP_SPRITE_SIZE);
        }
    }

    ctx.restore();
}

function renderDebugInfo(ctx: CanvasRenderingContext2D, deltaTime: number, game: Game) {
    const fontSize = 28;
    ctx.font = `${fontSize}px bold`

    game.dts.push(deltaTime);
    if (game.dts.length > 60) // can be any number of frames
        game.dts.shift();

    const dtAvg = game.dts.reduce((a, b) => a + b, 0)/game.dts.length;

    const labels = [];
    labels.push(`FPS: ${Math.floor(1/dtAvg)}`)
    switch (game.ws.readyState) {
        case WebSocket.CONNECTING: {
            labels.push('Connecting...');
        } break;
        case WebSocket.OPEN: {
            labels.push(`Ping: ${game.ping.toFixed(2)}ms`);
            labels.push(`Players: ${game.players.size}`);
        } break;
        case WebSocket.CLOSING:
        case WebSocket.CLOSED: {
            labels.push(`Offline`);
        } break;
    }

    const shadowOffset = fontSize*0.06
    const padding = 70
    for (let i = 0; i < labels.length; ++i) {
        ctx.fillStyle = "black"
        ctx.fillText(labels[i], padding, padding + fontSize*i);
        ctx.fillStyle = "white"
        ctx.fillText(labels[i], padding + shadowOffset, padding - shadowOffset + fontSize*i);
    }
}

interface Display {
    ctx: CanvasRenderingContext2D;
    backCtx: OffscreenCanvasRenderingContext2D;
    backImagePtr: number;
    backImageWidth: number;
    backImageHeight: number;
    zBufferPtr: number;
}

interface WasmClient extends common.WasmCommon {
    allocate_pixels: (width: number, height: number) => number,
    allocate_zbuffer: (width: number) => number,
    render_floor_and_ceiling: (pixels: number, pixels_width: number, pixels_height: number, position_x: number, position_y: number, direction: number) => void,
    render_column_of_wall: (display: number, display_width: number, display_height: number, zbuffer: number, cell: number, cell_width: number, cell_height: number, x: number, px: number, py: number, cx: number, cy: number) => void,
    render_walls: (display: number, display_width: number, display_height: number, zbuffer: number, wall: number, wall_width: number, wall_height: number, position_x: number, position_y: number, direction: number, scene: number, scene_width: number, scene_height: number) => void;
}

function createDisplay(ctx: CanvasRenderingContext2D, wasmClient: WasmClient, width: number, height: number): Display {
    const backImagePtr: number = wasmClient.allocate_pixels(width, height);
    const zBufferPtr: number = wasmClient.allocate_zbuffer(width);
    const backCanvas = new OffscreenCanvas(width, height);
    const backCtx = backCanvas.getContext("2d");
    if (backCtx === null) throw new Error("2D context is not supported");
    backCtx.imageSmoothingEnabled = false;
    return {
        ctx,
        backCtx,
        backImagePtr,
        backImageWidth: width,
        backImageHeight: height,
        zBufferPtr,
    };
}

function displaySwapBackImageData(display: Display, wasmClient: WasmClient) {
    const backImageData = new Uint8ClampedArray(wasmClient.memory.buffer, display.backImagePtr, display.backImageWidth*display.backImageHeight*4);
    display.backCtx.putImageData(new ImageData(backImageData, display.backImageWidth), 0, 0);
    display.ctx.drawImage(display.backCtx.canvas, 0, 0, display.ctx.canvas.width, display.ctx.canvas.height);
}

interface Sprite {
    image: WasmImage;
    position: Vector2;
    z: number;
    scale: number;
    cropPosition: Vector2;
    cropSize: Vector2;

    dist: number;  // Actual distance.
    pdist: number; // Perpendicular distance.
    t: number;     // Normalized horizontal position on the screen
}

function cullAndSortSprites(camera: Camera, spritePool: SpritePool, visibleSprites: Array<Sprite>) {
    const sp = new Vector2();
    const dir = new Vector2().setPolar(camera.direction);
    const fov = camera.fovRight.clone().sub(camera.fovLeft);

    visibleSprites.length = 0;
    for (let i = 0; i < spritePool.length; ++i) {
        const sprite = spritePool.items[i];

        sp.copy(sprite.position).sub(camera.position);
        const spl = sp.length();
        if (spl <= NEAR_CLIPPING_PLANE) continue; // Sprite is too close
        if (spl >= FAR_CLIPPING_PLANE) continue;  // Sprite is too far

        const cos = sp.dot(dir)/spl;
        // TODO: @perf the sprites that are invisible on the screen but within FOV 180° are not culled
        // It may or may not impact the performance of renderSprites()
        if (cos < 0) continue;  // Sprite is outside of the maximal FOV 180°
        sprite.dist = NEAR_CLIPPING_PLANE/cos;
        sp.norm().scale(sprite.dist).add(camera.position).sub(camera.fovLeft);
        sprite.t = sp.length()/fov.length()*Math.sign(sp.dot(fov));
        sprite.pdist = sprite.position.clone().sub(camera.position).dot(dir);

        // TODO: I'm not sure if these checks are necessary considering the `spl <= NEAR_CLIPPING_PLANE` above
        if (sprite.pdist < NEAR_CLIPPING_PLANE) continue;
        if (sprite.pdist >= FAR_CLIPPING_PLANE) continue;

        visibleSprites.push(sprite);
    }

    visibleSprites.sort((a, b) => b.pdist - a.pdist);
}

function renderSprites(display: Display, wasmClient: WasmClient, sprites: Array<Sprite>) {
    const backImageData = new Uint8ClampedArray(wasmClient.memory.buffer, display.backImagePtr, display.backImageWidth*display.backImageHeight*4);
    const zBuffer = new Float32Array(wasmClient.memory.buffer, display.zBufferPtr, display.backImageWidth);
    for (let sprite of sprites) {
        const cx = display.backImageWidth*sprite.t;
        const cy = display.backImageHeight*0.5;
        const maxSpriteSize = display.backImageHeight/sprite.pdist;
        const spriteSize = maxSpriteSize*sprite.scale;
        const x1 = Math.floor(cx - spriteSize*0.5);
        const x2 = Math.floor(x1 + spriteSize - 1);
        const bx1 = Math.max(0, x1);
        const bx2 = Math.min(display.backImageWidth-1, x2);
        const y1 = Math.floor(cy + maxSpriteSize*0.5 - maxSpriteSize*sprite.z);
        const y2 = Math.floor(y1 + spriteSize - 1);
        const by1 = Math.max(0, y1);
        const by2 = Math.min(display.backImageHeight-1, y2);

        const src = new Uint8ClampedArray(wasmClient.memory.buffer, sprite.image.ptr, sprite.image.width*sprite.image.height*4);
        const dest = backImageData;
        for (let x = bx1; x <= bx2; ++x) {
            if (sprite.pdist < zBuffer[x]) {
                for (let y = by1; y <= by2; ++y) {
                    const tx = Math.floor((x - x1)/spriteSize*sprite.cropSize.x);
                    const ty = Math.floor((y - y1)/spriteSize*sprite.cropSize.y);
                    const srcP = ((ty + sprite.cropPosition.y)*sprite.image.width + (tx + sprite.cropPosition.x))*4;
                    const destP = (y*display.backImageWidth + x)*4;
                    const alpha = src[srcP + 3]/255;
                    dest[destP + 0] = dest[destP + 0]*(1 - alpha) + src[srcP + 0]*alpha;
                    dest[destP + 1] = dest[destP + 1]*(1 - alpha) + src[srcP + 1]*alpha;
                    dest[destP + 2] = dest[destP + 2]*(1 - alpha) + src[srcP + 2]*alpha;
                }
            }
        }
    }
}

function pushSprite(spritePool: SpritePool, image: WasmImage, position: Vector2, z: number, scale: number, cropPosition?: Vector2, cropSize?: Vector2) {
    if (spritePool.length >= spritePool.items.length) {
        spritePool.items.push({
            image,
            position: new Vector2(),
            z,
            scale,
            pdist: 0,
            dist: 0,
            t: 0,
            cropPosition: new Vector2(),
            cropSize: new Vector2(),
        })
    }

    const last = spritePool.length;

    spritePool.items[last].image = image;
    spritePool.items[last].position.copy(position);
    spritePool.items[last].z = z;
    spritePool.items[last].scale = scale;
    spritePool.items[last].pdist = 0;
    spritePool.items[last].dist = 0;
    spritePool.items[last].t = 0;

    if (image instanceof WasmImage) {
        if (cropPosition === undefined) {
            spritePool.items[last].cropPosition.set(0, 0);
        } else {
            spritePool.items[last].cropPosition.copy(cropPosition);
        }
        if (cropSize === undefined) {
            spritePool.items[last]
                .cropSize
                .set(image.width, image.height)
                .sub(spritePool.items[last].cropPosition);
        } else {
            spritePool.items[last].cropSize.copy(cropSize);
        }
    } else {
        spritePool.items[last].cropPosition.set(0, 0);
        spritePool.items[last].cropSize.set(0, 0);
    }

    spritePool.length += 1;
}

function updateCamera(player: Player, camera: Camera) {
    const halfFov = FOV*0.5;
    const fovLen = NEAR_CLIPPING_PLANE/Math.cos(halfFov);
    camera.position.copy(player.position);
    camera.direction = properMod(player.direction, 2*Math.PI);
    camera.fovLeft.setPolar(camera.direction-halfFov, fovLen).add(camera.position);
    camera.fovRight.setPolar(camera.direction+halfFov, fovLen).add(camera.position);
}

function spriteOfItemKind(itemKind: common.ItemKind, assets: Assets): WasmImage {
    switch (itemKind) {
    case common.ItemKind.Key: return assets.keyImage;
    case common.ItemKind.Bomb: return assets.bombImage;
    default: return assets.nullImage;
    }
}

function updateItems(ws: WebSocket, spritePool: SpritePool, time: number, me: Player, items: Array<common.Item>, assets: Assets) {
    // Rendering the items as sprites
    for (let item of items) {
        if (item.alive) {
            pushSprite(spritePool, spriteOfItemKind(item.kind, assets), item.position, 0.25 + ITEM_AMP - ITEM_AMP*Math.sin(ITEM_FREQ*Math.PI*time + item.position.x + item.position.y), 0.25);
        }
    }

    // Offline mode. Updating items state without asking the server.
    if (ws.readyState != WebSocket.OPEN) {
        for (let item of items) {
            if (common.collectItem(me, item)) {
                playSound(assets.itemPickupSound, me.position, item.position);
            }
        }
    }
}

interface Particle {
    lifetime: number,
    position: Vector3,
    velocity: Vector3,
}

function allocateParticles(capacity: number): Array<Particle> {
    let bomb: Array<Particle> = []
    for (let i = 0; i < capacity; ++i) {
        bomb.push({
            position: new Vector3(),
            velocity: new Vector3(),
            lifetime: 0,
        })
    }
    return bomb
}

function updateParticles(assets: Assets, wasmCommon: common.WasmCommon, spritePool: SpritePool, deltaTime: number, scene: Scene, particles: Array<Particle>) {
    const walls = new Uint8ClampedArray(wasmCommon.memory.buffer, scene.wallsPtr, scene.width*scene.height);
    for (let particle of particles) {
        if (particle.lifetime > 0) {
            particle.lifetime -= deltaTime;
            particle.velocity.z -= common.BOMB_GRAVITY*deltaTime;

            const nx = particle.position.x + particle.velocity.x*deltaTime;
            const ny = particle.position.y + particle.velocity.y*deltaTime;
            if (sceneGetTile(walls, scene, new Vector2(nx, ny))) {
                const dx = Math.abs(Math.floor(particle.position.x) - Math.floor(nx));
                const dy = Math.abs(Math.floor(particle.position.y) - Math.floor(ny));

                if (dx > 0) particle.velocity.x *= -1;
                if (dy > 0) particle.velocity.y *= -1;
                particle.velocity.scale(PARTICLE_DAMP);
            } else {
                particle.position.x = nx;
                particle.position.y = ny;
            }

            const nz = particle.position.z + particle.velocity.z*deltaTime;
            if (nz < PARTICLE_SCALE || nz > 1.0) {
                particle.velocity.z *= -1
                particle.velocity.scale(PARTICLE_DAMP);
            } else {
                particle.position.z = nz;
            }

            if (particle.lifetime > 0) {
                pushSprite(spritePool, assets.particleImage, new Vector2(particle.position.x, particle.position.y), particle.position.z, PARTICLE_SCALE)
            }
        }
    }
}

function emitParticle(source: Vector3, particles: Array<Particle>) {
    for (let particle of particles) {
        if (particle.lifetime <= 0) {
            particle.lifetime = PARTICLE_LIFETIME;
            particle.position.copy(source);
            const angle = Math.random()*2*Math.PI;
            particle.velocity.x = Math.cos(angle);
            particle.velocity.y = Math.sin(angle);
            particle.velocity.z = Math.random()*0.5 + 0.5;
            particle.velocity.scale(PARTICLE_MAX_SPEED*Math.random());
            break;
        }
    }
}

function playSound(sound: HTMLAudioElement, playerPosition: Vector2, objectPosition: Vector2) {
    const maxVolume = 1;
    const distanceToPlayer = objectPosition.distanceTo(playerPosition);
    sound.volume = clamp(maxVolume / distanceToPlayer, 0.0, 1.0);
    sound.currentTime = 0;
    sound.play();
}

function explodeBomb(bomb: common.Bomb, player: Player, assets: Assets, particles: Array<Particle>) {
    playSound(assets.bombBlastSound, player.position, bomb.position.clone2());
    for (let i = 0; i < BOMB_PARTICLE_COUNT; ++i) {
        emitParticle(bomb.position, particles);
    }
}

function updateBombs(wasmCommon: common.WasmCommon, ws: WebSocket, spritePool: SpritePool, player: Player, bombs: Array<common.Bomb>, particles: Array<Particle>, scene: Scene, deltaTime: number, assets: Assets) {
    for (let bomb of bombs) {
        if (bomb.lifetime > 0) {
            pushSprite(spritePool, assets.bombImage, new Vector2(bomb.position.x, bomb.position.y), bomb.position.z, common.BOMB_SCALE)
            if (common.updateBomb(wasmCommon, bomb, scene, deltaTime)) {
                playSound(assets.bombRicochetSound, player.position, bomb.position.clone2());
            }

            if (ws.readyState != WebSocket.OPEN && bomb.lifetime <= 0) {
                explodeBomb(bomb, player, assets, particles)
            }
        }
    }
}

interface Assets {
    wallImage: WasmImage,
    keyImage: WasmImage,
    bombImage: WasmImage,
    playerImage: WasmImage,
    particleImage: WasmImage,
    nullImage: WasmImage,
    bombRicochetSound: HTMLAudioElement,
    itemPickupSound: HTMLAudioElement,
    bombBlastSound: HTMLAudioElement
}

interface Game {
    camera: Camera,
    ws: WebSocket,
    me: Player,
    players: Map<number, Player>,
    visibleSprites: Array<Sprite>,
    spritePool: SpritePool,
    particles: Array<Particle>,
    assets: Assets,
    ping: number,
    dts: number[],
    level: common.Level,
    wasmClient: WasmClient,
}

async function loadImage(url: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.src = url;
    return new Promise((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = reject;
    });
}

class WasmImage {
    ptr: number;
    width: number;
    height: number;
    constructor(ptr: number, width: number, height: number) {
        this.ptr = ptr;
        this.width = width;
        this.height = height;
    }
}

async function loadWasmImage(wasmClient: WasmClient, url: string): Promise<WasmImage> {
    const image = await loadImage(url);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2d canvas is not supported");
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    const ptr = wasmClient.allocate_pixels(image.width, image.height);
    new Uint8ClampedArray(wasmClient.memory.buffer, ptr, image.width*image.height*4).set(imageData.data);
    return new WasmImage(ptr, image.width, image.height);
}

async function instantiateWasmClient(url: string): Promise<WasmClient> {
    const wasm = await WebAssembly.instantiateStreaming(fetch(url), {
        "env": make_environment({
            "fmodf": (x: number, y: number) => x%y,
            "fminf": Math.min,
            "fmaxf": Math.max,
        })
    })

    return {
        wasm,
        memory: wasm.instance.exports.memory as WebAssembly.Memory,
        _initialize: wasm.instance.exports._initialize as () => void,
        allocate_scene: wasm.instance.exports.allocate_scene as (width: number, height: number) => number,
        allocate_pixels: wasm.instance.exports.allocate_pixels as (width: number, height: number) => number,
        allocate_zbuffer: wasm.instance.exports.allocate_zbuffer as (width: number) => number,
        render_floor_and_ceiling: wasm.instance.exports.render_floor_and_ceiling as (position_x: number, position_y: number, direction: number) => void,
        render_column_of_wall: wasm.instance.exports.render_column_of_wall as (display: number, display_width: number, display_height: number, zbuffer: number, cell: number, cell_width: number, cell_height: number, x: number, px: number, py: number, cx: number, cy: number) => void,
        render_walls: wasm.instance.exports.render_walls as (display: number, display_width: number, display_height: number, zbuffer: number, wall: number, wall_width: number, wall_height: number, position_x: number, position_y: number, direction: number, scene: number, scene_width: number, scene_height: number) => void,
    };
}

async function createGame(): Promise<Game> {
    const wasmClient = await instantiateWasmClient("client.wasm");
    wasmClient._initialize();

    const [
        wallImage,
        keyImage,
        bombImage,
        playerImage,
        particleImage,
        nullImage,
    ] = await Promise.all([
        loadWasmImage(wasmClient, "assets/images/custom/wall.png"),
        loadWasmImage(wasmClient, "assets/images/custom/key.png"),
        loadWasmImage(wasmClient, "assets/images/custom/bomb.png"),
        loadWasmImage(wasmClient, "assets/images/custom/player.png"),
        loadWasmImage(wasmClient, "assets/images/custom/particle.png"),
        loadWasmImage(wasmClient, "assets/images/custom/null.png"),
    ]);

    const itemPickupSound = new Audio("assets/sounds/bomb-pickup.ogg");
    const bombRicochetSound = new Audio("assets/sounds/ricochet.wav");
    const bombBlastSound = new Audio("assets/sounds/blast.ogg");
    const assets = {
        wallImage,
        keyImage,
        bombImage,
        playerImage,
        particleImage,
        nullImage,
        bombRicochetSound,
        itemPickupSound,
        bombBlastSound,
    }

    const particles = allocateParticles(1000);
    const visibleSprites: Array<Sprite> = [];
    const spritePool = createSpritePool();

    const players = new Map<number, Player>();

    const camera: Camera = {
        position: new Vector2(),
        direction: 0,
        fovLeft: new Vector2(),
        fovRight: new Vector2(),
    };
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.hostname}:${SERVER_PORT}`);
    // HACK: This application is deployed to GitHub Pages for the demo
    // purposes. Unfortunately, GitHub Pages only allow hosting static
    // assets, so we can only operate in Offline Mode. At the same
    // time, tsoding.github.io accepts WebSocket connection on the
    // port 6970 and later times out on the shandshake which results
    // in the client displaying "Connecting..." for the whole time,
    // which does not look good in the demo. So if we are on
    // tsoding.github.io we just instantly close the connection.
    if (window.location.hostname === 'tsoding.github.io') ws.close();
    const me = {
        id: 0,
        position: new Vector2(),
        direction: 0,
        moving: 0,
        hue: 0,
    };
    const level = common.createLevel(wasmClient);
    // TODO: make a better initialization of the items on client
    for (const item of level.items) item.alive = false;
    const game: Game = {
        camera, ws, me, ping: 0, players, particles, assets, spritePool, visibleSprites, dts: [],
        level, wasmClient
    };

    ws.binaryType = 'arraybuffer';
    ws.addEventListener("close", (event) => {
        console.log("WEBSOCKET CLOSE", event)
        game.players.clear();
    });
    ws.addEventListener("error", (event) => {
        // TODO: reconnect on errors
        console.log("WEBSOCKET ERROR", event)
    });
    ws.addEventListener("message", (event) => {
        // console.log('Received message', event);
        if (!(event.data instanceof ArrayBuffer)) {
            console.error("Received bogus-amogus message from server. Expected binary data", event);
            ws?.close();
        }
        const view = new DataView(event.data);
        if (common.HelloStruct.verify(view)) {
            game.me = {
                id: common.HelloStruct.id.read(view),
                position: new Vector2(common.HelloStruct.x.read(view), common.HelloStruct.y.read(view)),
                direction: common.HelloStruct.direction.read(view),
                moving: 0,
                hue: common.HelloStruct.hue.read(view)/256*360,
            }
            players.set(game.me.id, game.me)
        } else if (common.PlayersJoinedHeaderStruct.verify(view)) {
            const count = common.PlayersJoinedHeaderStruct.count(view);
            for (let i = 0; i < count; ++i) {
                const playerView = new DataView(event.data, common.PlayersJoinedHeaderStruct.size + i*common.PlayerStruct.size, common.PlayerStruct.size);
                const id = common.PlayerStruct.id.read(playerView);
                const player = players.get(id);
                if (player !== undefined) {
                    player.position.x = common.PlayerStruct.x.read(playerView);
                    player.position.y = common.PlayerStruct.y.read(playerView);
                    player.direction = common.PlayerStruct.direction.read(playerView);
                    player.moving = common.PlayerStruct.moving.read(playerView);
                    player.hue = common.PlayerStruct.hue.read(playerView)/256*360;
                } else {
                    const x = common.PlayerStruct.x.read(playerView);
                    const y = common.PlayerStruct.y.read(playerView);
                    players.set(id, {
                        id,
                        position: new Vector2(x, y),
                        direction: common.PlayerStruct.direction.read(playerView),
                        moving: common.PlayerStruct.moving.read(playerView),
                        hue: common.PlayerStruct.hue.read(playerView)/256*360,
                    });
                }
            }
        } else if (common.PlayersLeftHeaderStruct.verify(view)) {
            const count = common.PlayersLeftHeaderStruct.count(view);
            for (let i = 0; i < count; ++i) {
                const id = common.PlayersLeftHeaderStruct.items(i).id.read(view);
                players.delete(id);
            }
        } else if (common.PlayersMovingHeaderStruct.verify(view)) {
            const count = common.PlayersMovingHeaderStruct.count(view);
            for (let i = 0; i < count; ++i) {
                const playerView = new DataView(event.data, common.PlayersMovingHeaderStruct.size + i*common.PlayerStruct.size, common.PlayerStruct.size);

                const id = common.PlayerStruct.id.read(playerView);
                const player = players.get(id);
                if (player === undefined) {
                    console.error(`Received bogus-amogus message from server. We don't know anything about player with id ${id}`)
                    ws?.close();
                    return;
                }
                player.moving = common.PlayerStruct.moving.read(playerView);
                player.position.x = common.PlayerStruct.x.read(playerView);
                player.position.y = common.PlayerStruct.y.read(playerView);
                player.direction = common.PlayerStruct.direction.read(playerView);
            }
        } else if (common.PongStruct.verify(view)) {
            game.ping = performance.now() - common.PongStruct.timestamp.read(view);
        } else if (common.ItemCollectedStruct.verify(view)) {
            const index = common.ItemCollectedStruct.index.read(view);
            if (!(0 <= index && index < game.level.items.length)) {
                console.error(`Received bogus-amogus ItemCollected message from server. Invalid index ${index}`);
                ws?.close();
                return;
            }
            if (game.level.items[index].alive) {
                game.level.items[index].alive = false;
                playSound(assets.itemPickupSound, game.me.position, game.level.items[index].position);
            }
        } else if (common.ItemSpawnedStruct.verify(view)) {
            const index = common.ItemSpawnedStruct.index.read(view);
            if (!(0 <= index && index < game.level.items.length)) {
                console.error(`Received bogus-amogus ItemSpawned message from server. Invalid index ${index}`);
                ws?.close();
                return;
            }
            game.level.items[index].alive = true;
            game.level.items[index].kind = common.ItemSpawnedStruct.itemKind.read(view);
            game.level.items[index].position.x = common.ItemSpawnedStruct.x.read(view);
            game.level.items[index].position.y = common.ItemSpawnedStruct.y.read(view);
        } else if (common.BombSpawnedStruct.verify(view)) {
            const index = common.BombSpawnedStruct.index.read(view);
            if (!(0 <= index && index < game.level.bombs.length)) {
                console.error(`Received bogus-amogus BombSpawned message from server. Invalid index ${index}`);
                ws?.close();
                return;
            }
            game.level.bombs[index].lifetime = common.BombSpawnedStruct.lifetime.read(view);
            game.level.bombs[index].position.x = common.BombSpawnedStruct.x.read(view);
            game.level.bombs[index].position.y = common.BombSpawnedStruct.y.read(view);
            game.level.bombs[index].position.z = common.BombSpawnedStruct.z.read(view);
            game.level.bombs[index].velocity.x = common.BombSpawnedStruct.dx.read(view);
            game.level.bombs[index].velocity.y = common.BombSpawnedStruct.dy.read(view);
            game.level.bombs[index].velocity.z = common.BombSpawnedStruct.dz.read(view);
        } else if (common.BombExplodedStruct.verify(view)) {
            const index = common.BombExplodedStruct.index.read(view);
            if (!(0 <= index && index < game.level.bombs.length)) {
                console.error(`Received bogus-amogus BombExploded message from server. Invalid index ${index}`);
                ws?.close();
                return;
            }
            game.level.bombs[index].lifetime = 0.0;
            game.level.bombs[index].position.x = common.BombExplodedStruct.x.read(view);
            game.level.bombs[index].position.y = common.BombExplodedStruct.y.read(view);
            game.level.bombs[index].position.z = common.BombExplodedStruct.z.read(view);
            explodeBomb(level.bombs[index], me, assets, particles);
        } else {
            console.error("Received bogus-amogus message from server.", view)
            ws?.close();
        }
    });
    ws.addEventListener("open", (event) => {
        console.log("WEBSOCKET OPEN", event)
    });

    return game;
}

function spriteAngleIndex(cameraPosition: Vector2, entity: Player): number {
    return Math.floor(properMod(properMod(entity.direction, 2*Math.PI) - properMod(entity.position.clone().sub(cameraPosition).angle(), 2*Math.PI) - Math.PI + Math.PI/8, 2*Math.PI)/(2*Math.PI)*SPRITE_ANGLES_COUNT);
}

function renderGame(display: Display, deltaTime: number, time: number, game: Game) {
    resetSpritePool(game.spritePool);

    game.players.forEach((player) => {
        if (player !== game.me) updatePlayer(game.wasmClient, player, game.level.scene, deltaTime)
    });
    updatePlayer(game.wasmClient, game.me, game.level.scene, deltaTime);
    updateCamera(game.me, game.camera);
    updateItems(game.ws, game.spritePool, time, game.me, game.level.items, game.assets);
    updateBombs(game.wasmClient, game.ws, game.spritePool, game.me, game.level.bombs, game.particles, game.level.scene, deltaTime, game.assets);
    updateParticles(game.assets, game.wasmClient, game.spritePool, deltaTime, game.level.scene, game.particles)

    game.players.forEach((player) => {
        if (player !== game.me) {
            const index = spriteAngleIndex(game.camera.position, player);
            pushSprite(game.spritePool, game.assets.playerImage, player.position, 1, 1, new Vector2(55*index, 0), new Vector2(55, 55));
        }
    })

    game.wasmClient.render_floor_and_ceiling(display.backImagePtr, display.backImageWidth, display.backImageHeight, game.camera.position.x, game.camera.position.y, game.camera.direction);
    game.wasmClient.render_walls(
        display.backImagePtr, display.backImageWidth, display.backImageHeight, display.zBufferPtr,
        game.assets.wallImage.ptr, game.assets.wallImage.width, game.assets.wallImage.height,
        game.camera.position.x, game.camera.position.y, game.camera.direction,
        game.level.scene.wallsPtr, game.level.scene.width, game.level.scene.height);
    cullAndSortSprites(game.camera, game.spritePool, game.visibleSprites);
    renderSprites(display, game.wasmClient, game.visibleSprites);
    displaySwapBackImageData(display, game.wasmClient);

    if (MINIMAP) renderMinimap(game.wasmClient, display.ctx, game.camera, game.me, game.level.scene, game.spritePool, game.visibleSprites);
    renderDebugInfo(display.ctx, deltaTime, game);
}

function make_environment(...envs: any): any {
    return new Proxy(envs, {
        get(_target, prop, _receiver) {
            for (let env of envs) {
                if (env.hasOwnProperty(prop)) {
                    return env[prop];
                }
            }
            return (...args: any) => {
                throw new Error(`NOT IMPLEMENTED: ${String(prop)} ${args}`)
            }
        }
    });
}

(async () => {
    const gameCanvas = document.getElementById("game") as (HTMLCanvasElement | null);
    if (gameCanvas === null) throw new Error("No canvas with id `game` is found");
    const factor = 80;
    gameCanvas.width = 16*factor;
    gameCanvas.height = 9*factor;
    const ctx = gameCanvas.getContext("2d");
    if (ctx === null) throw new Error("2D context is not supported");
    ctx.imageSmoothingEnabled = false;

    // TODO: bring hotreloading back
    // TODO: hot reloading should not break if the game crashes

    const game = await createGame();
    const display = createDisplay(ctx, game.wasmClient, SCREEN_WIDTH, SCREEN_HEIGHT);

    window.addEventListener("keydown", (e) => {
        if (!e.repeat) {
            const direction = CONTROL_KEYS[e.code];
            if (direction !== undefined) {
                if (game.ws.readyState === WebSocket.OPEN) {
                    const view = new DataView(new ArrayBuffer(common.AmmaMovingStruct.size));
                    common.AmmaMovingStruct.kind.write(view, common.MessageKind.AmmaMoving);
                    common.AmmaMovingStruct.start.write(view, 1);
                    common.AmmaMovingStruct.direction.write(view, direction);
                    game.ws.send(view);
                } else {
                    game.me.moving |= 1<<direction;
                }
            } else if (e.code === 'Space') {
                if (game.ws.readyState === WebSocket.OPEN) {
                    const view = new DataView(new ArrayBuffer(common.AmmaThrowingStruct.size));
                    common.AmmaThrowingStruct.kind.write(view, common.MessageKind.AmmaThrowing);
                    game.ws.send(view);
                } else {
                    common.throwBomb(game.me, game.level.bombs);
                }
            }
        }
    });
    // TODO: When the window loses the focus, reset all the controls
    window.addEventListener("keyup", (e) => {
        if (!e.repeat) {
            const direction = CONTROL_KEYS[e.code];
            if (direction !== undefined) {
                if (game.ws.readyState === WebSocket.OPEN) {
                    const view = new DataView(new ArrayBuffer(common.AmmaMovingStruct.size));
                    common.AmmaMovingStruct.kind.write(view, common.MessageKind.AmmaMoving);
                    common.AmmaMovingStruct.start.write(view, 0);
                    common.AmmaMovingStruct.direction.write(view, direction);
                    game.ws.send(view);
                } else {
                    game.me.moving &= ~(1<<direction);
                }
            }
        }
    });

    const PING_COOLDOWN = 60;
    let prevTimestamp = 0;
    let pingCooldown = PING_COOLDOWN;
    const frame = (timestamp: number) => {
        const deltaTime = (timestamp - prevTimestamp)/1000;
        const time = timestamp/1000;
        prevTimestamp = timestamp;
        renderGame(display, deltaTime, time, game);
        if (game.ws.readyState == WebSocket.OPEN) {
            pingCooldown -= 1;
            if (pingCooldown <= 0) {
                const view = new DataView(new ArrayBuffer(common.PingStruct.size));
                common.PingStruct.kind.write(view, common.MessageKind.Ping);
                common.PingStruct.timestamp.write(view, performance.now());
                game.ws.send(view);
                pingCooldown = PING_COOLDOWN;
            }
        }
        window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame((timestamp) => {
        prevTimestamp = timestamp;
        window.requestAnimationFrame(frame);
    });
})();
// TODO: Hot reload assets
// TODO: Load assets asynchronously
//   While a texture is loading, replace it with a color tile.
// TODO: Mobile controls
// TODO: "magnet" items into the player
// TODO: Blast particles should fade out as they age
// TODO: Bomb collision should take into account its size
// TODO: Try lighting with normal maps that come with some of the assets
// TODO: Try cel shading the walls (using normals and stuff)
// TODO: sound don't mix properly
//   Right now same sounds are just stopped and replaced instantly. Which generally does not sound good.
//   We need to fix them properly
// TODO: consider looking into Web Audio API https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
