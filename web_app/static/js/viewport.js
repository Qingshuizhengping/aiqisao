(function () {
    'use strict';

    const root = document.documentElement;
    const input = document.getElementById('userInput');
    const mobileViewport = window.matchMedia('(max-width: 760px), (max-height: 500px) and (max-width: 1000px), (pointer: coarse)');
    let pendingFrame = 0;
    let pointerActive = false;

    function syncViewport() {
        if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
        const viewport = window.visualViewport;
        const isMobile = mobileViewport.matches;
        const keyboardVisible = viewport && Math.abs(viewport.scale - 1) < .05 &&
            Math.max(root.clientHeight, window.innerHeight) - viewport.height > 120;
        const keepEditing = root.classList.contains('is-input-focused') && (pointerActive || keyboardVisible);
        root.classList.toggle('is-input-focused', isMobile && (document.activeElement === input || keepEditing));

        if (!isMobile) {
            root.style.removeProperty('--app-height');
            root.style.removeProperty('--app-offset-top');
            root.classList.remove('is-viewport-short');
            return;
        }

        if (viewport && Math.abs(viewport.scale - 1) >= .05) return;

        const height = viewport ? viewport.height : window.innerHeight;
        const offsetTop = viewport ? Math.max(0, viewport.offsetTop) : 0;
        if (height > 0) root.style.setProperty('--app-height', height + 'px');
        root.style.setProperty('--app-offset-top', offsetTop + 'px');
        root.classList.toggle('is-viewport-short', height < 360);
    }

    function scheduleSync() {
        if (!pendingFrame) pendingFrame = window.requestAnimationFrame(syncViewport);
    }

    document.addEventListener('focusin', syncViewport);
    document.addEventListener('focusout', scheduleSync);
    document.addEventListener('pointerdown', function () { pointerActive = true; }, { passive: true });
    document.addEventListener('pointerup', function () { pointerActive = false; scheduleSync(); }, { passive: true });
    document.addEventListener('pointercancel', function () { pointerActive = false; scheduleSync(); }, { passive: true });
    mobileViewport.addEventListener('change', scheduleSync);
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', scheduleSync, { passive: true });
    window.addEventListener('pageshow', scheduleSync);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSync);
        window.visualViewport.addEventListener('scroll', scheduleSync, { passive: true });
    }

    syncViewport();
})();
