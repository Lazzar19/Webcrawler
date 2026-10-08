const fs = require("fs");
const path = require('path')
const os = require('os');

function getDesktopPath() {

    const platform = os.platform();
    const homeDir = os.homedir();

    if(platform == "win32") {
        return path.join(homeDir, "Desktop");
    } else if(platform == "linux") {
        const userDir = "/mnt/c/Users";

        if(fs.existsSync(userDir)) {
            const users = fs.readdirSync(userDir)
            .filter(u => !['Public', 'Default', 'All Users', 'Default User'].includes(u));


            for(const user of users) {
                const oneDrive = path.join(userDir, user, 'OneDrive', 'Desktop');
                const regularDesktop = path.join(userDir, user, 'Desktop');

                if(fs.existsSync(oneDrive)) return oneDrive;
                if(fs.existsSync(regularDesktop)) return regularDesktop;
            }
            
            return path.join(homeDir, 'Desktop');
        } else if(platform == 'darwin') {
            return path.join(homeDir, 'Desktop');
        }
    }

}

function printReport(pages)
{
    console.log(`==========`);
    console.log("REPORT");
    console.log(`==========`);

    const sortedPages = sortPages(pages);
    for(const sortedPage of sortedPages) {
        const pageURL = sortedPage[0];
        const hits = sortedPage[1];
        console.log(`Found ${hits} links to page ${pageURL}`);

    }
    console.log("\n\n");
    console.log(`==========`);
    console.log("END");
    console.log(`==========`);

    saveToCSV(pages);
}

function escapeCsvValue(value) {
    const valueString = String(value);
    const escaped = valueString.replace(/"/g,'""');
    return `"${escaped}"`;
}

function saveToCSV(pages) {
    const rows = [['URL', 'Count']]; //2d array
    for(const url in pages) {
        rows.push([url,pages[url]]);    
    }

    const csvContent = rows.map(row => row.map(escapeCsvValue).join(',')).join('\n');

    const rawKey = Object.keys(pages)[0];
    const fullURL = rawKey.startsWith('http') ? rawKey : `https://${rawKey}`;
    const siteName = new URL(fullURL).hostname;

    const resultsDir = path.join(getDesktopPath(), 'Results');

    if(!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);

    const outputPath = path.join(resultsDir, `${siteName}.csv`);
    
    fs.writeFileSync(outputPath, csvContent);

    console.log(`\n Results saved in ${outputPath}\n`);

}


function sortPages(pages) {
    const pagesArr = Object.entries(pages);
    pagesArr.sort((a,b) => {
        return b[1] - a[1];
    })

    return pagesArr;
}

module.exports = {
    sortPages,
    printReport
}