(function () {
    'use strict';

    const buttons = [...document.querySelectorAll('.glass-button')];
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const increasedContrast = window.matchMedia('(prefers-contrast: more)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const chromium = navigator.userAgentData?.brands.some(brand => /Chromium|Google Chrome|Microsoft Edge/.test(brand.brand))
        || /Chrome\//.test(navigator.userAgent);
    const namespace = 'http://www.w3.org/2000/svg';
    const records = new WeakMap();
    let definitions;

    function createElement(name, attributes) {
        const element = document.createElementNS(namespace, name);
        Object.entries(attributes).forEach(([attribute, value]) => element.setAttribute(attribute, value));
        return element;
    }

    function displacementMap(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        const image = context.createImageData(width, height);
        const radius = height / 2;
        const rim = Math.min(7, radius / 2);

        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const nearest = Math.max(radius, Math.min(width - radius, column + .5));
                const horizontal = column + .5 - nearest;
                const vertical = row + .5 - radius;
                const distance = Math.hypot(horizontal, vertical);
                const depth = radius - distance;
                const bend = depth > 0 && depth < rim ? Math.sin(depth / rim * Math.PI) : 0;
                const offset = (row * width + column) * 4;
                image.data[offset] = 128 + (distance ? horizontal / distance : 0) * bend * 110;
                image.data[offset + 1] = 128 + (distance ? vertical / distance : 0) * bend * 110;
                image.data[offset + 2] = 128;
                image.data[offset + 3] = 255;
            }
        }

        context.putImageData(image, 0, 0);
        return canvas.toDataURL();
    }

    function updateLens(button, index) {
        if (!chromium || reducedTransparency.matches || increasedContrast.matches) {
            button.style.removeProperty('--glass-refraction');
            return;
        }

        const width = Math.round(button.clientWidth);
        const height = Math.round(button.clientHeight);
        if (!width || !height) return;
        let record = records.get(button);
        if (record?.width === width && record?.height === height) {
            button.style.setProperty('--glass-refraction', `url("#${record.identifier}") saturate(1.25)`);
            return;
        }

        const map = displacementMap(width, height);
        if (!map) return;
        if (!definitions) {
            const svg = createElement('svg', { width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false' });
            svg.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden';
            definitions = createElement('defs', {});
            svg.append(definitions);
            document.body.append(svg);
        }

        if (!record) {
            const identifier = `qisao-glass-lens-${index}`;
            const filter = createElement('filter', { id: identifier, x: '0', y: '0', filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
            const image = createElement('feImage', { x: '0', y: '0', preserveAspectRatio: 'none', result: 'lens-map' });
            const displacement = createElement('feDisplacementMap', { in: 'SourceGraphic', in2: 'lens-map', scale: '8', xChannelSelector: 'R', yChannelSelector: 'G' });
            filter.append(image, displacement);
            definitions.append(filter);
            record = { identifier, filter, image };
            records.set(button, record);
        }

        record.width = width;
        record.height = height;
        record.filter.setAttribute('width', width);
        record.filter.setAttribute('height', height);
        record.image.setAttribute('width', width);
        record.image.setAttribute('height', height);
        record.image.setAttribute('href', map);
        button.style.setProperty('--glass-refraction', `url("#${record.identifier}") saturate(1.25)`);
    }

    function refresh() {
        buttons.forEach(updateLens);
    }

    function illuminate(event) {
        if (reducedMotion.matches || reducedTransparency.matches || increasedContrast.matches) return;
        const button = event.target.closest?.('.glass-button:not(:disabled)');
        if (!button) return;
        const rectangle = button.getBoundingClientRect();
        button.style.setProperty('--glass-x', `${(event.clientX - rectangle.left) / rectangle.width * 100}%`);
        button.style.setProperty('--glass-y', `${(event.clientY - rectangle.top) / rectangle.height * 100}%`);
    }

    document.addEventListener('pointermove', illuminate, { passive: true });
    document.addEventListener('pointerdown', illuminate, { passive: true });
    document.addEventListener('pointerout', event => {
        const button = event.target.closest?.('.glass-button');
        if (!button || button.contains(event.relatedTarget)) return;
        button.style.removeProperty('--glass-x');
        button.style.removeProperty('--glass-y');
    });
    reducedTransparency.addEventListener('change', refresh);
    increasedContrast.addEventListener('change', refresh);
    if (window.ResizeObserver) {
        const observer = new ResizeObserver(refresh);
        buttons.forEach(button => observer.observe(button));
    } else {
        window.addEventListener('resize', refresh);
    }
    refresh();
})();
