const { normalize } = require('path');
const {normalizeURL,getURLs, crawlPage} = require('../src/crawler/crawl.js');
const {test,expect} = require("@jest/globals");

const { createCrawlConfig } = require("../src/crawler/crawl-config.js");
const { create } = require('domain');


global.fetch = jest.fn();

beforeEach(() => {
    fetch.mockClear();
});

test('normalizeURL strip protocol https', () => {
    const input = 'https://blog.boot.dev/path';
    const actual = normalizeURL(input);
    const expected = 'blog.boot.dev/path';
    expect(actual).toEqual(expected);
})


test('normalizeURL strip trailing slash',() => {
    const input = 'https://blog.boot.dev/path/'; // dodata /
    const actual = normalizeURL(input);
    const expected = 'blog.boot.dev/path';
    expect(actual).toEqual(expected)
})

test('normalizeURL capitals', () => {
    const input = 'https://BLOG.boot.dev/path';
    const actual = normalizeURL(input);
    const expected = 'blog.boot.dev/path';
    expect(actual).toEqual(expected);
})


test('normalizeURL http', () => {
    const input = 'http://blog.boot.dev/path';
    const actual = normalizeURL(input);
    const expected = 'blog.boot.dev/path';
    expect(actual).toEqual(expected);
})


test('getURLsfromHTML absolute urls', () => {
    const inputBody = `
    <html>
        <body>
            <a href="https://blog.boot.dev/path/"
                Boot.dev BLOG
            </a>
        </body>
    </html>
    `
    const inputURL = 'https://blog.boot.dev/path/';
    const actual = getURLs(inputBody,inputURL);
    const expected = ['https://blog.boot.dev/path/'];
    expect(actual).toEqual(expected);
    
})


test('getURLsfromHTML relative urls', () => {
    const inputBody = `
    <html>
        <body>
            <a href="/path/"
                Boot.dev BLOG
            </a>
        </body>
    </html>
    `
    const inputURL = 'https://blog.boot.dev';
    const actual = getURLs(inputBody,inputURL);
    const expected = ['https://blog.boot.dev/path/'];
    expect(actual).toEqual(expected);
    
})

test('getURLsfromHTML both urls', () => {
    const inputBody = `
    <html>
        <body>

            <a href="https://blog.boot.dev/path1/"
                Boot.dev BLOG path 1
            </a>

            <a href="/path2/"
                Boot.dev BLOG path 2
            </a>


        </body>
    </html>
    `
    const inputURL = 'https://blog.boot.dev';
    const actual = getURLs(inputBody,inputURL);
    const expected = ['https://blog.boot.dev/path1/','https://blog.boot.dev/path2/'];
    expect(actual).toEqual(expected);
    
})


test('getURLsfromHTML invalid urls', () => {
    const inputBody = `
    <html>
        <body>
            <a href="invalid"
                Invalid url
            </a>
        </body>
    </html>
    `
    const inputURL = 'https://blog.boot.dev';
    const actual = getURLs(inputBody,inputURL);
    const expected = [];
    expect(actual).toEqual(expected);
    
})


test('getURLsFromHTML handles html with 0 links', () => {
    const inputBody = `
        <html>
            <body>  
                <h1> Some random text <h1>
            <body>
        </html>
    `;
    const inputURL = 'https://example.com';
    const actual = getURLs(inputBody,inputURL);
    const expected = [];
    expect(actual).toEqual(expected);
})


test('getURLsfromHTML handles empty HTML', () => {
    const inputBody = ``;
    const inputURL = 'https://example.com';
    const actual = getURLs(inputBody,inputURL);
    const expected = [];  //because of empty html
    expect(actual).toEqual(expected);
})

test('getURLsfromHTML malformed HTML', () => {

    const inputBody = `
        <html>
            <body>
                <a href="/page1"> Unclosed link
                <a href = /page2> No qoutes </a>
                <a href = ""> Empty href </a>
                <a href = "   "> whitespace in href </a>    

            </body>
        </html>
    `;

    const inputURL = 'https://example.com';
    const actual = getURLs(inputBody,inputURL);
    const expected = ['https://example.com/page1', 'https://example.com/page2'];
    expect(actual).toEqual(expected);

})


test("cyclic pages ", async () => {
   const inputA = `
    <html>
        <body>
            <a href="/pageB"> 
                Go to page B
            </a>
        </body>
    </html>
   
   `;

   const inputB = `
    <html>
        <body>
            <a href="/pageA">
                Go to page A
            </a>
        </body>
   
    </html>
   `
    

    fetch.mockImplementation((url) => {
        if(url === "https://example.com/pageA") {
            return Promise.resolve({
                status:200,
                headers: {
                    get: () => 'text/html'  //same as content-type: text/html
                },
                text: () => Promise.resolve(inputA) // same as response.text() => return html 
            });
        }

        if(url === "https://example.com/pageB") {
            return Promise.resolve({
                status:200,
                headers: {
                    get: () => 'text/html'
                },
                text: () => Promise.resolve(inputB)
            });
        }

        return Promise.reject(new Error('Unknown page'))

    })

    const config = createCrawlConfig({
        maxDepth: 3
    });

    const pages = await crawlPage("https://example.com", 'https://example.com/pageA', {},0, config);
    expect(pages['example.com/pageA']).toBeDefined();
    expect(pages['example.com/pageB']).toBeDefined();
    expect(pages['example.com/pageA']).toBeGreaterThanOrEqual(1);
    expect(pages['example.com/pageB']).toBe(1);

})


test.each([
    'application/json',
    'application/javascript',
    'image/png',
    'application/pdf',
    'text/css'
])('ignore non HTML types', async (contentType) => {
    fetch.mockImplementation( () => {
        return Promise.resolve({
            status:200,
            headers: {
                get: () => contentType
            },
            text: () => Promise.resolve('')
        })  
    })

    const config = createCrawlConfig({
        maxDepth: 3
    });

    const pages = await crawlPage('https://example.com', 'https://example.com/file',{},0, config);
    expect(pages).toEqual({'example.com/file': 1});

});


test(' text/html test with charset param', async () => {
    fetch.mockImplementation( () => {
        return Promise.resolve({
            status: 200,
            headers: {
                get: () => 'text/html; charset=UTF-8'
            },
            text: () => Promise.resolve('<html></html>')
        })
    })

    const config = createCrawlConfig({
        maxDepth: 3
    });

    const pages = await crawlPage('https://example.com', 'https://example.com', {}, 0, config);
    expect(pages['example.com']).toBeDefined();

})

test('ignore external links ', async() => {

    const html = `
    <html>
        <body>

            <a href="https://external.com/page"> External pegae </a>

        </body>
    </html>
    
    
    `;

    fetch.mockImplementation( (url) => {
        if(url === 'https://example.com')
        return Promise.resolve({
            status:200,
            headers: {
                get: () => 'text/html'
            },
            text: () => Promise.resolve(html)
        })

        return Promise.reject(new Error('External site, fetch error'));
    })

    const config = createCrawlConfig({
        maxDepth: 3
    });

    const pages = await crawlPage('https://example.com', 'https://example.com', {}, 0, config);
    expect(pages['example.com']).toBeDefined();
    expect(Object.keys(pages).length).toBe(1); // just one page, external link being ignored

})


test('depth limiting', async () => {

    const html = `
        <html>
            <body>
                <a href ="/page2"> Page 2 </a>
            </body>
        </html>
    `;

    fetch.mockImplementation( () => {
        return Promise.resolve( {
            status: 200,
            headers: {
                get: () => 'text/html'
            },
            text: () => Promise.resolve(html)
        })
    })

    const config = createCrawlConfig({
        maxDepth: 1
    });

    const pages = await crawlPage('https://example.com', "https://example.com", {}, 0, config);
    expect(pages['example.com']).toBeDefined();
    expect(pages['example.com/page2']).toBeUndefined();
    expect(Object.keys(pages).length).toBe(1);

})



