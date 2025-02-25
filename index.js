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
    const urls = ['/video/sRMMwpDTs5k', '/channel/UCRijo3ddMTht_IHyNSNXpNQ', '/videos/UCRijo3ddMTht_IHyNSNXpNQ']

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
  const info = await yt.getInfo(req.params.id, 'ANDROID');
  if (info.playability_status.status !== 'OK') {
    ws.send(`This video is not available for download (${info.playability_status.status} ${info.playability_status.reason}).`);
    return ws.close()
  }

  const videoOptions = {
    format: 'mp4',
    quality: req.params.quality,
    type: 'video'
  }
  const videoFormat = chooseFormat(videoOptions, info['streaming_data'])
  if (!videoFormat) {
    ws.send('No matching formats found... Please try again later.')
    return ws.close()
  }

  const videoStream = await info.download({
    itag: videoFormat.itag
  })
  const videoWriteStream = fs.createWriteStream(`./output/${req.params.id}_video.mp4`)

  let videoTotal = videoFormat.content_length;
  const whitelistedVideos = JSON.parse(fs.readFileSync('./whitelist.json'))
  if (videoTotal > (1_048_576 * 150) && !whitelistedVideos.includes(req.params.id)) {
    ws.send('Is this content considered high risk? If so, please email me at admin@preservetube.com.');
    ws.send('This video is too large, and unfortunately, Preservetube does not have unlimited storage.');
    return ws.close()
  }

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

    if (videoPrecentages.includes((progress * 100).toFixed(0))) continue
    videoPrecentages.push((progress * 100).toFixed(0))

    ws.send(`[video] ${(progress * 100).toFixed(2)}% of ${hr.fromBytes(videoTotal)} at ${speedInMBps.toFixed(2)} MB/s ETA ${secondsToTime(remainingTime.toFixed(0))}`)
  }

  ws.send(`The video has been downloaded. ${!videoFormat.has_audio ? ' Downloading the audio.' : ''}`)

  if (!videoFormat.has_audio) {
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

      if (audioPrecentages.includes((progress * 100).toFixed(0))) continue
      audioPrecentages.push((progress * 100).toFixed(0))

      ws.send(`[audio] ${(progress * 100).toFixed(2)}% of ${hr.fromBytes(audioTotal)} at ${speedInMBps.toFixed(2)} MB/s ETA ${secondsToTime(remainingTime.toFixed(0))}`)
    }

    ws.send('Downloaded video and audio. Merging them together.')

    await mergeIt(`./output/${req.params.id}_audio.mp4`, `./output/${req.params.id}_video.mp4`, `./output/${req.params.id}.mp4`)
  } else {
    fs.renameSync(`./output/${req.params.id}_video.mp4`, `./output/${req.params.id}.mp4`)
  }

  if (fs.existsSync(`./output/${req.params.id}_audio.mp4`)) fs.rmSync(`./output/${req.params.id}_audio.mp4`)
  if (fs.existsSync(`./output/${req.params.id}_video.mp4`)) fs.rmSync(`./output/${req.params.id}_video.mp4`)

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

// stolen straight from youtubei.js
function chooseFormat(options, streaming_data) {
  if (!streaming_data) return null

  const formats = [
    ...(streaming_data.formats || []),
    ...(streaming_data.adaptive_formats || [])
  ];
  
  if (options.itag) {
    const candidates = formats.filter((format) => format.itag === options.itag);
    if (!candidates.length) return null
    return candidates[0];
  }

  const requires_audio = options.type ? options.type.includes('audio') : true;
  const requires_video = options.type ? options.type.includes('video') : true;
  const language = options.language || 'original';
  const quality = options.quality || 'best';

  let best_width = -1;

  const is_best = [ 'best', 'bestefficiency' ].includes(quality);
  const use_most_efficient = quality !== 'best';

  let candidates = formats.filter((format) => {
    if (requires_audio && !format.has_audio)
      return false;
    if (requires_video && !format.has_video)
      return false;
    if (options.codec && !format.mime_type.includes(options.codec))
      return false;
    if (options.format !== 'any' && !format.mime_type.includes(options.format || 'mp4'))
      return false;
    if (!is_best && format.quality_label !== quality)
      return false;
    if (format.width && (best_width < format.width))
      best_width = format.width;
    return true;
  });

  if (!candidates.length) return null

  if (is_best && requires_video)
    candidates = candidates.filter((format) => format.width === best_width);

  if (requires_audio && !requires_video) {
    const audio_only = candidates.filter((format) => {
      if (language !== 'original') {
        return !format.has_video && !format.has_text && format.language === language;
      }
      return !format.has_video && !format.has_text && format.is_original;

    });
    if (audio_only.length > 0) {
      candidates = audio_only;
    }
  }

  if (use_most_efficient) {
    // Sort by bitrate (lower is better)
    candidates.sort((a, b) => a.bitrate - b.bitrate);
  } else {
    // Sort by bitrate (higher is better)
    candidates.sort((a, b) => b.bitrate - a.bitrate);
  }

  return candidates.filter(v => v.content_length)[0];
}

async function switchIps() {
  const currentIp = await (await fetch('http://localhost:8000/v1/publicip/ip', {
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
      const newIp = await (await fetch('http://localhost:8000/v1/publicip/ip', {
        headers: {
          'X-API-Key': '64d1781e469965c1cdad611b0c05d313',
        },
      })).json();

      if (newIp.public_ip !== '') {
        console.log(`finished switching ips. ${newIp.public_ip}, ${newIp.city}, ${newIp.region}, ${newIp.organization}. took ${(new Date().getTime() - currentDate.getTime()) / 1000}s`)
        clearInterval(intervalId);
        resolve()
      }
    }, 500);
  })
}

setInterval(switchIps, 30 * 60000) // 30 minutes

app.listen(8008, () => {
  console.log('the metadata server is up.')
  switchIps()
})