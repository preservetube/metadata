const express = require('express')
const { Innertube, Utils } = require('youtubei.js');
const hr = require('@tsmx/human-readable')

const ffmpeg = require('fluent-ffmpeg')
const ffmpegStatic = require('ffmpeg-static')
const fs = require('node:fs')

const app = express()
require('express-ws')(app)

ffmpeg.setFfmpegPath(ffmpegStatic)

const maxRetries = 5
const platforms = ['iOS', 'YTSTUDIO_ANDROID', 'WEB', 'YTMUSIC_ANDROID', 'YTMUSIC', 'TV_EMBEDDED']

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

app.ws('/download/:id/:quality', async (ws, req) => {
    const yt = await Innertube.create();
    const info = await yt.getInfo(req.params.id, 'iOS');

    const videoOptions = {
        format: 'mp4',
        quality: req.params.quality,
        type: 'video'
    }
    const videoFormat = info.chooseFormat(videoOptions)
    const videoStream = await info.download(videoOptions)
    const videoWriteStream = fs.createWriteStream(`./output/${req.params.id}_video.mp4`)

    let videoTotal = videoFormat.content_length;
    let videoDownloaded = 0;
    let videoStartTime = Date.now();
    const videoPrecentages = []

    for await (const chunk of Utils.streamToIterable(videoStream)) {
        videoWriteStream.write(chunk);
        videoDownloaded += chunk.length;
        
        let elapsedTime = (Date.now() - videoStartTime) / 1000; 
        let progress = videoDownloaded / videoTotal;
        let speedInMBps = (videoDownloaded / (1024 * 1024)) / elapsedTime; 
        let remainingTime = (videoTotal - videoDownloaded) / (speedInMBps * 1024 * 1024); 

        if (videoPrecentages.includes((progress*100).toFixed(0))) continue 
        videoPrecentages.push((progress*100).toFixed(0))
        
        ws.send(`[video] ${(progress * 100).toFixed(2)}% of ${hr.fromBytes(videoTotal)} at ${speedInMBps.toFixed(2)} MB/s ETA ${secondsToTime(remainingTime.toFixed(0))}`)
    }

    ws.send('The video has been downloaded. Downloading the audio.')

    const audioOptions = {
        type: 'audio',
        quality: 'bestefficiency'
    }
    const audioFormat = info.chooseFormat(audioOptions)
    const audioStream = await info.download(audioOptions)
    const audioWriteStream = fs.createWriteStream(`./output/${req.params.id}_audio.mp4`)

    let audioTotal = audioFormat.content_length;
    let audioDownloaded = 0;
    let audioStartTime = Date.now();
    const audioPrecentages = []

    for await (const chunk of Utils.streamToIterable(audioStream)) {
        audioWriteStream.write(chunk);
        audioDownloaded += chunk.length;
        
        let elapsedTime = (Date.now() - audioStartTime) / 1000; 
        let progress = audioDownloaded / audioTotal;
        let speedInMBps = (audioDownloaded / (1024 * 1024)) / elapsedTime; 
        let remainingTime = (audioTotal - audioDownloaded) / (speedInMBps * 1024 * 1024); 

        if (audioPrecentages.includes((progress*100).toFixed(0))) continue 
        audioPrecentages.push((progress*100).toFixed(0))
        
        ws.send(`[audio] ${(progress * 100).toFixed(2)}% of ${hr.fromBytes(audioTotal)} at ${speedInMBps.toFixed(2)} MB/s ETA ${secondsToTime(remainingTime.toFixed(0))}`)
    }

    ws.send('Downloaded video and audio. Merging them together.')

    await mergeIt(`./output/${req.params.id}_audio.mp4`, `./output/${req.params.id}_video.mp4`, `./output/${req.params.id}.mp4`)
    fs.rmSync(`./output/${req.params.id}_audio.mp4`)
    fs.rmSync(`./output/${req.params.id}_video.mp4`)

    ws.send('done')
    ws.close()
});

function secondsToTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const formattedSeconds = remainingSeconds < 10 ? '0' + remainingSeconds : remainingSeconds;
    return `${minutes}:${formattedSeconds}`;
}

function mergeIt(audioPath, videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .addInput(videoPath)
            .addInput(audioPath)
            .outputOptions('-c:v copy') 
            .outputOptions('-c:a aac') 
            .output(outputPath)
            .on('end', () => {
                resolve('Merging finished!');
            })
            .on('error', (err) => {
                reject(new Error('An error occurred: ' + err.message));
            })
            .run();
    });
}

app.listen(8008, () => {
    console.log('the metadata server is up.')
})