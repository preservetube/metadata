const express = require('express')
const { Innertube } = require('youtubei.js');
const app = express()

const maxRetries = 5
const platforms = ['YTSTUDIO_ANDROID', 'WEB', 'YTMUSIC_ANDROID', 'YTMUSIC', 'TV_EMBEDDED']

app.get('/health', async (req, res) => {
    try {
        const urls = ['/video/sRMMwpDTs5k', '/channel/UCRijo3ddMTht_IHyNSNXpNQ', '/videos/UCRijo3ddMTht_IHyNSNXpNQ', '/cobalt']

        const results = await Promise.all(urls.map(async (url) => {
            const response = await fetch(`http://localhost:8008${url}`);
            const jsonData = await response.json();
            const status = jsonData.error ? 'unhealthy' : 'healthy';
            return { url, status };
        }));

        console.log('Health check results:', results);

        const isHealthy = results.every(result => result.status === 'healthy');
        if (isHealthy) {
            res.status(200).json({ message: 'All endpoints are healthy', results });
        } else {
            res.status(500).json({ error: 'Health check failed', results });
        }
    } catch (error) {
        console.error('Health check failed:', error.message);
        res.status(500).json({ error: 'Health check failed', results: [], errorMessage: error.message });
    }
})

app.get('/video/:id', async (req, res) => {
    let error = ''

    for (let retries = 0; retries < maxRetries; retries++) {
        try {
            const platform = platforms[retries % platforms.length];
            const yt = await Innertube.create();
            const info = await yt.getInfo(req.params.id, platform);

            if (!info) {
                error = 'ErrorCantConnectToServiceAPI'
                continue; 
            }
            if (info.playability_status.status !== 'OK') {
                error = 'ErrorYTUnavailable'
                continue; 
            }
            if (info.basic_info.is_live) {
                error = 'ErrorLiveVideo'
                continue;
            }
            if (info.basic_info.title == 'Video Not Available') {
                error = 'YoutubeIsFuckingWithMe'
                continue;
            }
            return res.json(info)
        } catch (error) {
            continue
        }
    }

    res.json({ error: error || 'ErrorUnknown' })
})

app.get('/channel/:id', async (req, res) => {
    let error = ''

    for (let retries = 0; retries < maxRetries; retries++) {
        try {
            const platform = platforms[retries % platforms.length];
            const yt = await Innertube.create();
            const info = await yt.getChannel(req.params.id, platform);

            if (!info) {
                error = 'ErrorCantConnectToServiceAPI'
                continue; 
            }
            return res.json(info)
        } catch (error) {
            continue
        }
    }

    res.json({ error: error || 'ErrorUnknown' })
})

app.get('/videos/:id', async (req, res) => {
    try {
        const videos = [];
        const yt = await Innertube.create();
        const channel = await yt.getChannel(req.params.id);
        let json = await channel.getVideos();
    
        videos.push(...json.videos);
    
        while (json.has_continuation && videos.length < 60) {
            json = await getNextPage(json);
            videos.push(...json.videos);
        }
    
        return res.json(videos)
    } catch (e) {
        res.json(false)
    }
    
    async function getNextPage(json) {
        const page = await json.getContinuation();
        return page;
    }
})

app.get('/cobalt', async (req, res) => {
    let json = {
        error: 'unreachable'
    }

    for (let retries = 0; retries < maxRetries; retries++) {
        try {
            json = await (await fetch('http://127.0.0.1:9000/api/json', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    'url': 'https://www.youtube.com/watch?v=WIKqgE4BwAY'
                })
            })).json()

            if (json.error) continue
            return res.json(json)
        } catch (error) {
            continue
        }
    }

    res.json(json)
})

app.listen(8008, () => {
    console.log('the metadata server is up.')
})