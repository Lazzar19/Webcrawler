
const {JSDOM} = require('jsdom');
const pLimit = require('p-limit');
const limit = pLimit(5);

async function crawlPage(baseURL,currentURL,pages, currentDepth = 0 , config) {

    const baseURLObject = new URL(baseURL);
    const currentURLObject = new URL(currentURL);
    if(baseURLObject.hostname !== currentURLObject.hostname) {
        return pages;
    }

    const normalizedCurrentURL = normalizeURL(currentURL);
    if(pages[normalizedCurrentURL] > 0) {
        pages[normalizedCurrentURL] ++;
        return pages;
    }

        
    if(currentDepth >= config.maxDepth) {
        return pages;
    }


    pages[normalizedCurrentURL] = 1;

    if(Object.keys(pages).length >= config.maxPages)
        return pages;

    

    console.log(`crawling page: ${currentURL}`);
    try {
        const response = await fetch(currentURL);

        if(response.status > 399) {
            console.log(`error in fetch with status code: ${response.status} on page ${currentURL}`);
            return pages;
        }

        const contentType = response.headers.get("content-type");
        if(!contentType.includes('text/html') || !contentType)
        {
            console.log(`non html response, content-type: ${contentType}, on page ${currentURL}`);
            return pages;
        }
        //parse to html
        const htmlBody =  await response.text();
        const nextURLs = getURLs(htmlBody,baseURL);

            
        const crawlPromises = nextURLs.map(url =>
            limit(() => crawlPage(baseURL, url, pages, currentDepth + 1, config))
        );
        await Promise.all(crawlPromises);
        

    } catch(err) {
        console.log(`error in fetch: ${err.message}, on page ${currentURL}`)
        return pages;
    }

    return pages;

}


function getURLs(htmlBody,baseURL) {
    const urls = [];
    const dom = new JSDOM(htmlBody);
    const linkElements = dom.window.document.querySelectorAll("a");
    for(const link of linkElements) {

        if(!link.href) {
            continue;
        };

        if(link.href.slice(0,1) === '/') { // first character /
            //relative
            try{
                const urlObject = new URL(`${baseURL}${link.href}`);
                urls.push(urlObject.href);
            } catch (err) {
                console.log(`error with relative url: ${err.message}`)
            }

           
        } else {

            //absolute
           try{
                const urlObject = new URL(link.href);
                urls.push(urlObject.href);
           } catch (err) {
                console.log(`erro with absolute url: ${err.message}`);
           }
        }
    }
    return urls;
}


function normalizeURL(urlString) {
    const urlObject = new URL(urlString);
    const hostPath =  `${urlObject.hostname}${urlObject.pathname}`;

    if(hostPath.length > 0 && hostPath.slice(-1) == '/') {
        return hostPath.slice(0,-1); // return substring from first to last char
    }
    return hostPath;
};

module.exports = {
    normalizeURL,
    getURLs,
    crawlPage
}