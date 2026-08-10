const {
    DEFAULT_CONFIG,
    createCrawlConfig
} = require('../src/crawler/crawl-config.js');


describe('createCrawlConfig', () => {

    test('returns default configuration', () => {
        const config = createCrawlConfig();

        expect(config).toEqual(DEFAULT_CONFIG);
    });


    test('allows custom configuration values', () => {
        const config = createCrawlConfig({
            maxDepth: 5,
            maxPages: 100,
            concurrency: 10
        });

        expect(config.maxDepth).toBe(5);
        expect(config.maxPages).toBe(100);
        expect(config.concurrency).toBe(10);
    });


    test('allows partial configuration overrides', () => {
        const config = createCrawlConfig({
            maxDepth: 10
        });

        expect(config.maxDepth).toBe(10);
        expect(config.maxPages).toBe(Infinity);
        expect(config.concurrency).toBe(5);
    });


    test('returns a frozen configuration', () => {
        const config = createCrawlConfig();

        expect(Object.isFrozen(config)).toBe(true);
    });


});


describe('configuration validation', () => {

    describe('maxDepth', () => {

        test('accepts zero', () => {
            expect(() => {
                createCrawlConfig({
                    maxDepth: 0
                });
            }).not.toThrow();
        });


        test('rejects negative values', () => {
            expect(() => {
                createCrawlConfig({
                    maxDepth: -1
                });
            }).toThrow('Invalid maxDepth');
        });


        test('rejects non-integer values', () => {
            expect(() => {
                createCrawlConfig({
                    maxDepth: 1.5
                });
            }).toThrow('Invalid maxDepth');
        });

    });


    describe('maxPages', () => {

        test('accepts Infinity', () => {
            expect(() => {
                createCrawlConfig({
                    maxPages: Infinity
                });
            }).not.toThrow();
        });


        test('accepts positive integers', () => {
            expect(() => {
                createCrawlConfig({
                    maxPages: 100
                });
            }).not.toThrow();
        });


        test('rejects zero', () => {
            expect(() => {
                createCrawlConfig({
                    maxPages: 0
                });
            }).toThrow('Invalid maxPages');
        });


        test('rejects negative values', () => {
            expect(() => {
                createCrawlConfig({
                    maxPages: -1
                });
            }).toThrow('Invalid maxPages');
        });

    });


    describe('concurrency', () => {

        test('accepts positive integers', () => {
            expect(() => {
                createCrawlConfig({
                    concurrency: 10
                });
            }).not.toThrow();
        });


        test('rejects zero', () => {
            expect(() => {
                createCrawlConfig({
                    concurrency: 0
                });
            }).toThrow('Invalid concurrency');
        });


        test('rejects negative values', () => {
            expect(() => {
                createCrawlConfig({
                    concurrency: -1
                });
            }).toThrow('Invalid concurrency');
        });


        test('rejects non-integer values', () => {
            expect(() => {
                createCrawlConfig({
                    concurrency: 2.5
                });
            }).toThrow('Invalid concurrency');
        });

    });

});