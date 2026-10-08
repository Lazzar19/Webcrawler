const { URL } = require("url");

class RobotsHandler {
  constructor() {
    this.cache = new Map();
  }

  /**
   * @param {string} siteURL - baseURL of the site
   * @returns {Promise<string>} - robots.txt
   */
  async fetchRobotsTxt(siteURL) {
    let baseURL
    try {
       baseURL = new URL(siteURL).origin; // e.g., https://example.com
      
    } catch {
      console.log(`Malformed url: ${siteURL} `)
      return '';
    }
    
    const robotsURL = `${baseURL}/robots.txt`;

    // Check cache
    if (this.cache.has(baseURL)) {
      const cached = this.cache.get(baseURL);
      const oneHour = 60 * 60 * 1000;
      if (Date.now() - cached.timestamp < oneHour) {
        return cached.content;
      }
    }

    try {

        const controller = new AbortController();
        const timeout = setTimeout( () => controller.abort(), 10000);
        

        const response = await fetch(robotsURL, {
          method: 'GET',
          headers: {'User-Agent': "MyCrawlerBot/1.0"},
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if(response.status === 200) {
          const data = await response.text();
          this.cache.set(baseURL, {
            content:data,
            timestamp: Date.now()
          });
          return data;
        } else {
          return ''; // no robots.txt file
        }

    } catch (error){ 
        console.log(`Failed to fetch robots.txt from ${baseURL}`,error.message);
        return '';
    }
  }


  /**
   * @param {string} robotsContent - robots.txt body
   * @returns {Map<string, Object>} - user-agent map
   */
  parseRobotsTxt = (robotsContent) => {
    const lines = robotsContent.split('\n');
    const agentRules = new Map();

    let currentUserAgents = [];
    let currentRules = {
      disallow: [],
      allow: [],
      crawlDelay: null,
      sitemap: []
    };
    
    
    const saveCurrentRules = () => {
      if (currentUserAgents.length > 0) {
        currentUserAgents.forEach(agent => {
          if (!agentRules.has(agent)) {
            agentRules.set(agent, { 
              disallow: [...currentRules.disallow],
              allow: [...currentRules.allow],
              crawlDelay: currentRules.crawlDelay,
              sitemap: [...currentRules.sitemap]
            });
          } else {
            //merge rules if they already exist
            const existing = agentRules.get(agent);
            existing.disallow.push(...currentRules.disallow);
            existing.allow.push(...currentRules.allow);
            if (currentRules.crawlDelay !== null) existing.crawlDelay = currentRules.crawlDelay;
            if (currentRules.sitemap.length) existing.sitemap.push(...currentRules.sitemap);
          }
        });
      }
    };

    for (let line of lines) {
      line = line.trim();

      if (!line || line.startsWith('#')) continue;

      const [rawKey, ...rest] = line.split(':');
      if (!rawKey || rest.length === 0) continue;

      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();

      switch (key) {
        case 'user-agent':
          // Save previous rules if we have any rules and we're starting a new block
          if (currentUserAgents.length > 0 && (
              currentRules.disallow.length > 0 ||
              currentRules.allow.length > 0 ||
              currentRules.crawlDelay !== null ||
              currentRules.sitemap.length > 0
          )) {
            saveCurrentRules();
            // Reset for new block
            currentUserAgents = [];
            currentRules = {
              disallow: [],
              allow: [],
              crawlDelay: null,
              sitemap: []
            };
          }
          
          // Add new user agent to current list
          currentUserAgents.push(value.toLowerCase());
          break;

        case 'disallow':
          currentRules.disallow.push(value);
          break;

        case 'allow':
          currentRules.allow.push(value);
          break;

        case 'crawl-delay':
          currentRules.crawlDelay = parseFloat(value);
          break;

        case 'sitemap':
          currentRules.sitemap.push(value);
          break;

        default:
          break;
      }
    }
    // Handle the last user agent(s)
    saveCurrentRules();

    return agentRules;
  }

   getRulesFromAgent = (userAgent, parsedRobotsTxt) => {
      const agents = parsedRobotsTxt;
      const agentKey = userAgent.toLowerCase();  // GoogleBot == googlebot

      // looking for rules for that exact agent, for example googlebot
      if(agents.has(agentKey)) {
        return agents.get(agentKey);
      }

      // example for 'googlebot/2.1', we have googlebot so agentKey.includes(key) will return true
      for(const [key, rules] of agents.entries()) {
        if(key !== '*' && agentKey.includes(key)) {
          return rules;
        }
      }

      // rules for all agents
      if(agents.has('*')) return agents.get('*');

      // default rules when no match found
      return {
        disallow: [],
        allow: ['/'], // all is allowed because there is no disallow rule
        crawlDelay: null, //crawl can start instantly
        sitemap: []
      };
  };
}

module.exports = {
  RobotsHandler
};