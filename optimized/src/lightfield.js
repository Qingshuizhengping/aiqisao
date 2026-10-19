/**
 * 背景光场 —— 极简 WebGL（约 1 个全屏三角，单 pass）
 *
 * 为什么不引 three.js：这里只需要"一层缓慢流动的柔光"，用原生 WebGL
 * 大约 4KB 就能画完；three.js 光核心就 150KB+，对首屏是纯负担。
 *
 * 策略：低分辨率渲染（0.65×DPR）→ 让浏览器插值放大 → 30fps → 页面
 * 不可见时停帧 → 用户偏好减少动效时根本不会加载本文件。
 */
(function () {
    'use strict';

    var canvas = document.getElementById('lightField');
    if (!canvas) return;

    var gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false
    }) || canvas.getContext('experimental-webgl');

    if (!gl) {
        canvas.style.display = 'none';
        return;
    }

    var VERT = [
        'attribute vec2 aPos;',
        'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }'
    ].join('\n');

    var FRAG = [
        'precision mediump float;',
        'uniform vec2 uRes;',
        'uniform float uTime;',
        'uniform float uDark;',
        '',
        'float hash(vec2 p) {',
        '    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
        '}',
        '',
        'float pool(vec2 p, vec2 c, float radius) {',
        '    vec2 d = p - c;',
        '    return exp(-dot(d, d) / (radius * radius));',
        '}',
        '',
        'void main() {',
        '    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);',
        '    float t = uTime * 0.055;',
        '',
        '    // 四个缓慢漂移的光池，冷蓝 / 雾紫 / 灰白',
        '    vec2 c1 = vec2(-0.52 + 0.09 * sin(t * 1.13),  0.40 + 0.06 * cos(t * 0.87));',
        '    vec2 c2 = vec2( 0.58 + 0.08 * cos(t * 0.79),  0.22 + 0.07 * sin(t * 1.21));',
        '    vec2 c3 = vec2( 0.16 + 0.11 * sin(t * 0.61), -0.52 + 0.06 * cos(t * 0.95));',
        '    vec2 c4 = vec2(-0.30 + 0.07 * cos(t * 1.42), -0.30 + 0.09 * sin(t * 0.71));',
        '',
        '    float a = 0.0;',
        '    a += pool(p, c1, 0.62) * 0.62;',
        '    a += pool(p, c2, 0.55) * 0.50;',
        '    a += pool(p, c3, 0.70) * 0.58;',
        '    a += pool(p, c4, 0.36) * 0.30;',
        '',
        '    // 极轻的波纹，让光池边界不是死板的圆',
        '    a += 0.035 * sin(p.x * 5.0 + t * 2.6) * sin(p.y * 4.2 - t * 1.9);',
        '    float amt = clamp(a, 0.0, 1.0);',
        '',
        '    vec3 tint = vec3(0.56, 0.66, 0.86);',
        // 浅色下只留 12% 的着色，保证大面积仍然是纯白；深色下才明显
        '    vec3 lightMode = vec3(1.0) - (vec3(1.0) - tint) * amt * 0.055;',
        '    vec3 darkMode  = vec3(0.031, 0.035, 0.043) + tint * amt * 0.26;',
        '    vec3 col = mix(lightMode, darkMode, uDark);',
        '',
        '    // 抖动，消除大面积渐变里的色带',
        '    col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * (1.6 / 255.0);',
        '',
        '    gl_FragColor = vec4(col, 1.0);',
        '}'
    ].join('\n');

    function compile(type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { canvas.style.display = 'none'; return; }

    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { canvas.style.display = 'none'; return; }
    gl.useProgram(program);

    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    var aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(program, 'uRes');
    var uTime = gl.getUniformLocation(program, 'uTime');
    var uDark = gl.getUniformLocation(program, 'uDark');

    var darkTarget = document.documentElement.dataset.theme === 'dark' ? 1 : 0;
    var darkCurrent = darkTarget;
    var rafId = 0;
    var start = performance.now();
    var lastFrame = 0;
    var FRAME_MS = 1000 / 30;

    function resize() {
        var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        var scale = dpr * 0.65;
        var width = Math.min(Math.max(1, Math.round(canvas.clientWidth * scale)), 1600);
        var height = Math.min(Math.max(1, Math.round(canvas.clientHeight * scale)), 1600);
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
        gl.uniform2f(uRes, width, height);
    }

    function frame(now) {
        rafId = requestAnimationFrame(frame);
        if (now - lastFrame < FRAME_MS) return;
        lastFrame = now;

        // 主题切换时用 0.45s 过渡，避免硬跳
        darkCurrent += (darkTarget - darkCurrent) * 0.12;
        if (Math.abs(darkTarget - darkCurrent) < 0.002) darkCurrent = darkTarget;

        gl.uniform1f(uTime, (now - start) / 1000);
        gl.uniform1f(uDark, darkCurrent);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function startLoop() {
        if (rafId) return;
        lastFrame = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stopLoop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopLoop();
        else startLoop();
    });

    window.addEventListener('qisao:theme', function (event) {
        darkTarget = event.detail === 'dark' ? 1 : 0;
    });

    canvas.addEventListener('webglcontextlost', function (event) {
        event.preventDefault();
        stopLoop();
    });

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 180);
    }, { passive: true });

    resize();

    // 首帧先画一次，避免出现空白
    gl.uniform1f(uTime, 0);
    gl.uniform1f(uDark, darkCurrent);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    startLoop();
})();
