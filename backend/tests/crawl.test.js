const { getURLs } = require("../src/crawler/crawl.js");
const { canonicalKey } = require("../src/crawler/url-policy");
const { test, expect } = require("@jest/globals");

test("canonical key keeps the scheme", () => {
  expect(canonicalKey("https://blog.boot.dev/path")).toBe("https://blog.boot.dev/path");
});

test("canonical key removes one trailing slash", () => {
  expect(canonicalKey("https://blog.boot.dev/path/")).toBe("https://blog.boot.dev/path");
});

test("canonical key lowercases the hostname and keeps the scheme", () => {
  expect(canonicalKey("https://BLOG.boot.dev/path")).toBe("https://blog.boot.dev/path");
});

test("http and https stay different keys", () => {
  expect(canonicalKey("http://blog.boot.dev/path")).toBe("http://blog.boot.dev/path");
  expect(canonicalKey("http://blog.boot.dev/path")).not.toBe(
    canonicalKey("https://blog.boot.dev/path")
  );
});

test("getURLsfromHTML absolute urls", () => {
  const inputBody = `
    <html>
        <body>
            <a href="https://blog.boot.dev/path/"
                Boot.dev BLOG
            </a>
        </body>
    </html>
    `;
  const inputURL = "https://blog.boot.dev/path/";
  const actual = getURLs(inputBody, inputURL);
  const expected = ["https://blog.boot.dev/path/"];
  expect(actual).toEqual(expected);
});

test("getURLsfromHTML relative urls", () => {
  const inputBody = `
    <html>
        <body>
            <a href="/path/"
                Boot.dev BLOG
            </a>
        </body>
    </html>
    `;
  const inputURL = "https://blog.boot.dev";
  const actual = getURLs(inputBody, inputURL);
  const expected = ["https://blog.boot.dev/path/"];
  expect(actual).toEqual(expected);
});

test("getURLsfromHTML both urls", () => {
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
    `;
  const inputURL = "https://blog.boot.dev";
  const actual = getURLs(inputBody, inputURL);
  const expected = ["https://blog.boot.dev/path1/", "https://blog.boot.dev/path2/"];
  expect(actual).toEqual(expected);
});

test("getURLsfromHTML invalid urls", () => {
  const inputBody = `
    <html>
        <body>
            <a href="invalid"
                Invalid url
            </a>
        </body>
    </html>
    `;
  const inputURL = "https://blog.boot.dev";
  const actual = getURLs(inputBody, inputURL);
  const expected = ["https://blog.boot.dev/invalid"];
  expect(actual).toEqual(expected);
});

test("getURLsFromHTML handles html with 0 links", () => {
  const inputBody = `
        <html>
            <body>  
                <h1> Some random text <h1>
            <body>
        </html>
    `;
  const inputURL = "https://example.com";
  const actual = getURLs(inputBody, inputURL);
  const expected = [];
  expect(actual).toEqual(expected);
});

test("getURLsfromHTML handles empty HTML", () => {
  const inputBody = "";
  const inputURL = "https://example.com";
  const actual = getURLs(inputBody, inputURL);
  const expected = [];
  expect(actual).toEqual(expected);
});

test("getURLsfromHTML malformed HTML", () => {
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

  const inputURL = "https://example.com";
  const actual = getURLs(inputBody, inputURL);
  const expected = ["https://example.com/page1", "https://example.com/page2"];
  expect(actual).toEqual(expected);
});
