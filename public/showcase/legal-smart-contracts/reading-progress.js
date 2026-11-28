
class LegalSmartContractsReadingTracker {
    constructor() {
        this.article = document.getElementById("article-content");
        this.progressFill = document.getElementById("progress-fill");
        this.progressTrack = document.getElementById("progress-track");
        this.readingTime = document.getElementById("reading-time");

        this.wordsPerMinute = 200;

        this.initialize();
    }

    // Calculate estimated reading time
    computeReadTime(text, wordsPerMinute) {
        const words = text.trim().split(/\s+/).filter(Boolean).length;

        if (words === 0 || wordsPerMinute <= 0) {
            return 0;
        }

        return Math.ceil(words / wordsPerMinute);
    }

    // Update reading progress based on scroll position
    updateScrollProgress(scrollTop, maxScroll) {
        const progress = maxScroll > 0
            ? Math.min(100, Math.max(0, (scrollTop / maxScroll) * 100))
            : 100;

        this.progressFill.style.width = `${progress}%`;

        this.progressTrack.setAttribute(
            "aria-valuenow",
            Math.round(progress)
        );

        // Calculate remaining reading time
        const totalMinutes = this.computeReadTime(
            this.article.innerText,
            this.wordsPerMinute
        );

        const remainingMinutes = Math.ceil(
            totalMinutes * (1 - progress / 100)
        );

        this.readingTime.textContent =
            remainingMinutes === 0
                ? "Finished reading"
                : `${remainingMinutes} min remaining`;

        return progress;
    }

    // Listen for scrolling
    bindScrollListener() {
        const update = () => {
            const scrollTop = window.scrollY;
            const maxScroll =
                document.documentElement.scrollHeight - window.innerHeight;

            this.updateScrollProgress(scrollTop, maxScroll);
        };

        window.addEventListener("scroll", update, { passive: true });

        window.addEventListener("resize", update);

        update();
    }

    // Initialize the tracker
    initialize() {
        if (!this.article || !this.progressFill ||
            !this.progressTrack || !this.readingTime) {
            return;
        }

        this.bindScrollListener();
    }
}

// Start the reading tracker
document.addEventListener("DOMContentLoaded", () => {
    new LegalSmartContractsReadingTracker();
});
