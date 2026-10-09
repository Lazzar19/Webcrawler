const pLimit = require('p-limit');
const { canonicalKey, extractLinks } = require("./url-policy");
const limit = pLimit(5);

async function crawlPage(baseURL,currentURL,pages, currentDepth = 0 , config) {

    const baseURLObject = new URL(baseURL);
    const currentURLObject = new URL(currentURL);
    if(baseURLObject.hostname !== currentURLObject.hostname) {
        return pages;
    }

    const normalizedCurrentURL = canonicalKey(currentURL);
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
        const nextURLs = getURLs(htmlBody, currentURL);

            
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


function getURLs(htmlBody, baseURL) {
    return extractLinks(htmlBody, baseURL);
}

module.exports = {
    getURLs,
    crawlPage
}