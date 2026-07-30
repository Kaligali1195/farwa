(function () {
    const viewer = document.getElementById('imageViewer');
    const viewerImage = document.getElementById('viewerImage');
    const viewerTitle = document.getElementById('viewerTitle');
    const viewerCounter = document.getElementById('viewerCounter');
    const previousButton = document.getElementById('viewerPrev');
    const nextButton = document.getElementById('viewerNext');

    if (!viewer || !viewerImage || !viewerTitle || !viewerCounter || !previousButton || !nextButton) {
        return;
    }

    let images = [];
    let currentIndex = 0;
    let currentTitle = '';

    function renderImage() {
        if (images.length === 0) {
            return;
        }

        const image = images[currentIndex];
        viewerImage.src = image;
        viewerImage.alt = currentTitle + ' picture ' + (currentIndex + 1);
        viewerTitle.textContent = currentTitle;
        viewerCounter.textContent = (currentIndex + 1) + ' of ' + images.length;
        previousButton.disabled = images.length <= 1;
        nextButton.disabled = images.length <= 1;
    }

    function openViewer(nextImages, startIndex, title) {
        images = nextImages;
        currentIndex = Math.max(0, Math.min(startIndex, images.length - 1));
        currentTitle = title || 'Product image';
        renderImage();
        viewer.classList.add('is-open');
        viewer.setAttribute('aria-hidden', 'false');
        document.body.classList.add('viewer-open');
    }

    function closeViewer() {
        viewer.classList.remove('is-open');
        viewer.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('viewer-open');
        viewerImage.src = '';
    }

    function move(direction) {
        if (images.length <= 1) {
            return;
        }

        currentIndex = (currentIndex + direction + images.length) % images.length;
        renderImage();
    }

    document.querySelectorAll('.gallery-trigger').forEach((button) => {
        button.addEventListener('click', () => {
            let parsedImages = [];

            try {
                parsedImages = JSON.parse(button.dataset.galleryImages || '[]');
            } catch (error) {
                parsedImages = [];
            }

            parsedImages = parsedImages.filter((image) => typeof image === 'string' && image.length > 0);

            if (parsedImages.length === 0) {
                return;
            }

            openViewer(parsedImages, Number(button.dataset.galleryIndex || 0), button.dataset.galleryTitle || '');
        });
    });

    document.querySelectorAll('[data-viewer-close]').forEach((button) => {
        button.addEventListener('click', closeViewer);
    });

    previousButton.addEventListener('click', () => move(-1));
    nextButton.addEventListener('click', () => move(1));

    document.addEventListener('keydown', (event) => {
        if (!viewer.classList.contains('is-open')) {
            return;
        }

        if (event.key === 'Escape') {
            closeViewer();
        }

        if (event.key === 'ArrowLeft') {
            move(-1);
        }

        if (event.key === 'ArrowRight') {
            move(1);
        }
    });
})();
