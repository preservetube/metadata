import express from 'express';
import { Innertube } from 'youtubei.js'
import * as cheerio from 'cheerio';
import * as fs from 'node:fs'

import { EnabledTrackTypes } from 'googlevideo/utils';
import {
  createOutputStream,
  createStreamSink,
  createSabrStream,
  type DownloadOutput
} from './utils/sabr-stream-factory.js';
import type { SabrPlaybackOptions } from 'googlevideo/sabr-stream';
import { getVideoStreams, downloadStream, getInfo } from './utils/companion';

const ffmpeg = require('fluent-ffmpeg')

const app = express();
require('express-ws')(app)
ffmpeg.setFfmpegPath('/usr/local/bin/ffmpeg')

const maxRetries = 5
const platforms = ['IOS', 'ANDROID', 'YTSTUDIO_ANDROID', 'YTMUSIC_ANDROID']

app.get('/health', async (req, res) => {
  try {
    const urls = ['/video/sRMMwpDTs5k', '/channel/UCRijo3ddMTht_IHyNSNXpNQ', '/videos/UCRijo3ddMTht_IHyNSNXpNQ']

    const results = await Promise.all(urls.map(async (url) => {
      const response = await fetch(`http://localhost:8008${url}`);
      const jsonData: any = await response.json();
      const status = jsonData.error ? 'unhealthy' : 'healthy';
      return { url, status };
    }));

    console.log('Health check results:', results);

    const isHealthy = results.every(result => result.status === 'healthy');
    if (isHealthy) {
      res.status(200).json({ message: 'All endpoints are healthy', results });
    } else {
      res.status(500).json({ error: 'Health check failed', results });
      switchIps()
    }
  } catch (error:any) {
    console.error('Health check failed:', error.message);
    switchIps()
    res.status(500).json({ error: 'Health check failed', results: [], errorMessage: error.message });
  }
})

app.get('/video/:id', async (req, res) => {
  const info = await getInfo(req.params.id);

  if (!info) {
    return res.json({ error: 'ErrorCantConnectToServiceAPI' })
  }
  if (info.playabilityStatus!.status !== 'OK') {
    return res.json({ error: 'ErrorYTUnavailable' })
  }
  if (info.videoDetails.isLive) {
    return res.json({ error: 'ErrorLiveVideo' })
  }
  if (info.videoDetails.title == 'Video Not Available') {
    return res.json({ error: 'YoutubeIsFuckingWithMe' })
  }

  return res.json(info)
})

app.get('/channel/:id', async (req, res) => {
  let error = ''

  for (let retries = 0; retries < maxRetries; retries++) {
    try {
      const yt = await Innertube.create();
      const info = await yt.getChannel(req.params.id);

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

  async function getNextPage(json: any) {
    const page = await json.getContinuation();
    return page;
  }
})

interface Config {
  whitelist: string[]
  useCompanion: boolean
  maxVideoSize: number // in MB
}

// @ts-ignore
app.ws('/download/:id', async (ws, req) => {
  const config: Config = await Bun.file('config.json').json()
  let quality = '480p'

  const info = await getInfo(req.params.id);
  if (info.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText) {
    ws.send(`This video is not available for download (${info.playabilityStatus.errorScreen.playerErrorMessageRenderer.subreason.simpleText}).`);
    return ws.close()
  }
  
  if (!info || info.videoDetails.lengthSeconds == undefined) {
    ws.send('Unable to retrieve video info from YouTube. Please try again later.');
    return ws.close()
  }

  if (info.playabilityStatus?.status !== 'OK') {
    ws.send(`This video is not available for download (${info.playabilityStatus?.status} ${info.playabilityStatus?.reason}).`);
    return ws.close()
  } else if (info.videoDetails.isLive) {
    ws.send('This video is live, and cannot be downloaded.');
    return ws.close()
  } else if (info.videoDetails.videoId != req.params.id) {
    ws.send('This video is not available for download. Youtube is serving a different video.');
    return ws.close()
  } 

  if (parseInt(info.videoDetails.lengthSeconds) >= 900) quality = '360p' // 15min
  quality = getVideoQuality(info, quality)

  let audioOutputStream: DownloadOutput | undefined;
  let videoOutputStream: DownloadOutput | undefined;

  if (config.useCompanion) {
    const streamOptions = {
      videoQuality: quality,
      audioQuality: 'AUDIO_QUALITY_LOW'
    };
    const { streamResults, error } = await getVideoStreams(req.params.id, info.streamingData!.adaptiveFormats, streamOptions);
    if (streamResults == false) {
      ws.send(error)
      return ws.close()
    }

    const { videoStreamUrl, audioStreamUrl, selectedFormats } = streamResults;

    const videoSizeTotal = (parseInt(selectedFormats.audioFormat.contentLength) || 0) 
      + (parseInt(selectedFormats.videoFormat.contentLength) || 0)

    if (videoSizeTotal > (1_048_576 * config.maxVideoSize) && !config.whitelist.includes(req.params.id)) {
      ws.send('Is this content considered high risk? If so, please email me at admin@preservetube.com.');
      ws.send('This video is too large, and unfortunately, Preservetube does not have unlimited storage.');
      return ws.close()
    } else if (!selectedFormats.videoFormat.contentLength) {
      ws.send('Youtube isn\'t giving us enough information to be able to tell if we can process this video.')
      ws.send('Please try again later.')
      return ws.close()
    }

    audioOutputStream = createOutputStream(req.params.id, selectedFormats.audioFormat.mimeType!);
    videoOutputStream = createOutputStream(req.params.id, selectedFormats.videoFormat.mimeType!);

    await Promise.all([
      downloadStream(videoStreamUrl, selectedFormats.videoFormat, videoOutputStream.stream, ws, 'video'),
      downloadStream(audioStreamUrl, selectedFormats.audioFormat, audioOutputStream.stream, ws, 'audio')
    ]);
  } else {
    const streamOptions: SabrPlaybackOptions = {
      videoQuality: quality,
      audioQuality: 'AUDIO_QUALITY_LOW',
      enabledTrackTypes: EnabledTrackTypes.VIDEO_AND_AUDIO
    };
    const { streamResults } = await createSabrStream(req.params.id, streamOptions);
    const { videoStream, audioStream, selectedFormats } = streamResults;

    const videoSizeTotal = (selectedFormats.audioFormat.contentLength || 0) 
      + (selectedFormats.videoFormat.contentLength || 0)

    if (videoSizeTotal > (1_048_576 * config.maxVideoSize) && !config.whitelist.includes(req.params.id)) {
      ws.send('Is this content considered high risk? If so, please email me at admin@preservetube.com.');
      ws.send('This video is too large, and unfortunately, Preservetube does not have unlimited storage.');
      return ws.close()
    } else if (!selectedFormats.videoFormat.contentLength) {
      ws.send('Youtube isn\'t giving us enough information to be able to tell if we can process this video.')
      ws.send('Please try again later.')
      return ws.close()
    }

    audioOutputStream = createOutputStream(req.params.id, selectedFormats.audioFormat.mimeType!);
    videoOutputStream = createOutputStream(req.params.id, selectedFormats.videoFormat.mimeType!);

    await Promise.all([
      videoStream.pipeTo(createStreamSink(selectedFormats.videoFormat, videoOutputStream.stream, ws, 'video')),
      audioStream.pipeTo(createStreamSink(selectedFormats.audioFormat, audioOutputStream.stream, ws, 'audio'))
    ]);
  }

  if (audioOutputStream == undefined || videoOutputStream == undefined) {
    ws.send('This should not happen. Please report it via admin@preservetube.com.')
    return ws.close()
  }

  ws.send('Downloaded video and audio. Merging them together.')

  await mergeIt(audioOutputStream.filePath, videoOutputStream.filePath, `./output/${req.params.id}.mp4`, ws)
  await cleanupTempFiles([ audioOutputStream.filePath, videoOutputStream.filePath ]);

  ws.send('done')
  ws.close()
});

app.get('/getWebpageJson', async (req, res) => {
  if (!req.query.url) return res.send('no url')

  const ytRes = await fetch(req.query.url as string);
  if (!ytRes.ok) return res.status(500).send('failed to fetch youtube url')

  const html = await ytRes.text();
  const $ = cheerio.load(html);
  let found: string | null = null;

  $('script').each((_, el) => {
    const scriptContent = $(el).html();
    if (scriptContent && scriptContent.includes('var ytInitialData = ')) {
      const jsonStr = scriptContent.split('var ytInitialData = ')[1]?.split("};")[0];
      if (jsonStr) {
        found = jsonStr + "}";
        return false;
      }
    }
  });

  if (!found) return res.status(500).send('failed to find youtube json')
  try {
    res.json(JSON.parse(found))
  } catch (_) {
    res.status(500).send('failed to parse youtube json')
  }
})

function getVideoQuality(json: any, quality: string) {
  const adaptiveFormats = json.streamingData.adaptiveFormats;
  let video = adaptiveFormats.find((f: any) => f.qualityLabel === quality && !f.audioQuality);

  if (!video) {
    const target = parseInt(quality);
    video = adaptiveFormats // find the quality thats closest to the one we wanted
      .filter((f: any) => !f.audioQuality && f.qualityLabel)
      .reduce((prev: any, curr: any) => {
        const currDiff = Math.abs(parseInt(curr.qualityLabel) - target);
        const prevDiff = prev ? Math.abs(parseInt(prev.qualityLabel) - target) : Infinity;
        return currDiff < prevDiff ? curr : prev;
      }, null);
  }

  return video ? video.qualityLabel : null;
}

function mergeIt(audioPath: string, videoPath: string, outputPath: string, ws: any) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([ '-c:v copy', '-c:a copy', '-map 0:v:0', '-map 1:a:0', '-movflags +faststart' ])
      .on('progress', (progress:any) => {
        if (progress.percent) {
          ws.send(`[merging] ${progress.precent}% done`)
        }
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err:any) => {
        reject(new Error(`Error merging files: ${err.message}`));
      })
      .save(outputPath);
  });
}

async function cleanupTempFiles(files: string[]) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      console.warn(`Failed to delete temp file ${file}:`, error);
    }
  }
}

async function switchIps() {
  const currentIp: any = await (await fetch('http://localhost:8000/v1/publicip/ip', {
    headers: {
      'X-API-Key': '64d1781e469965c1cdad611b0c05d313'
    }
  })).json()
  const currentDate = new Date()

  console.log(`starting switching ips. ${currentIp.public_ip}, ${currentIp.city}, ${currentIp.region}, ${currentIp.organization}`)

  const s = await fetch('http://localhost:8000/v1/vpn/status', {
    method: 'PUT',
    headers: {
      'X-API-Key': '64d1781e469965c1cdad611b0c05d313',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'stopped' })
  })
  console.log(`stopped vpn - ${await s.text()}`)

  const r = await fetch('http://localhost:8000/v1/vpn/status', {
    method: 'PUT',
    headers: {
      'X-API-Key': '64d1781e469965c1cdad611b0c05d313',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'running' })
  })
  console.log(`turned on vpn - ${await r.text()}`)

  await new Promise((resolve, reject) => {
    const intervalId = setInterval(async () => {
      const newIp: any = await (await fetch('http://localhost:8000/v1/publicip/ip', {
        headers: {
          'X-API-Key': '64d1781e469965c1cdad611b0c05d313',
        },
      })).json();

      if (newIp.public_ip !== '') {
        console.log(`finished switching ips. ${newIp.public_ip}, ${newIp.city}, ${newIp.region}, ${newIp.organization}. took ${(new Date().getTime() - currentDate.getTime()) / 1000}s`)
        clearInterval(intervalId);
        resolve('done')
      }
    }, 500);
  })
}

// setInterval(switchIps, 30 * 60000) // 30 minutes

app.listen(8008, () => {
  console.log('the metadata server is up.')
  // switchIps()
})