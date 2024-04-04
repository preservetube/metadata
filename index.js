const express = require('express')
const { Innertube } = require('youtubei.js');
const app = express()

const maxRetries = 5
const platforms = ['YTSTUDIO_ANDROID', 'WEB', 'iOS', 'YTMUSIC_ANDROID', 'YTMUSIC', 'TV_EMBEDDED']

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

app.listen(8008, () => {
    console.log('the metadata server is up.')
})