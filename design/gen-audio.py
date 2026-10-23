# -*- coding: utf-8 -*-
"""双弈小程序音频素材合成：BGM（五声音阶拨弦 ambient）+ 落子/胜负/提示音效。

用法：python design/gen-audio.py
输出：miniprogram/assets/audio/*.mp3（无 lameenc 时降级为 16bit WAV）
"""
import os
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'assets', 'audio')
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(20261023)


def t_axis(n):
    return np.arange(n) / SR


def normalize(x, peak=0.9):
    m = np.max(np.abs(x))
    if m < 1e-6:
        return x
    return x / m * peak


def soft_limit(x):
    return np.tanh(x * 1.2) * 0.9


# ---------- 基础音色 ----------

def pluck(freq, dur, decay=1.1, harm=(1.0, 0.42, 0.22, 0.10, 0.05), nail=0.12):
    """拨弦：基频 + 泛音 + 指甲瞬态，指数衰减"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.zeros(n)
    for i, h in enumerate(harm):
        detune = 1 + 0.0015 * i
        s += h * np.sin(2 * np.pi * freq * (i + 1) * detune * t)
    env = np.exp(-t / decay) * np.clip(t / 0.006, 0, 1)
    s *= env
    noise = rng.standard_normal(n) * np.exp(-t / 0.005) * nail
    return s + noise


def bass_pluck(freq, dur, decay=2.2):
    return pluck(freq, dur, decay=decay, harm=(1.0, 0.3, 0.12), nail=0.04) * 0.8


def bell(freq, dur=1.0, decay=0.55, harm=(1.0, 0.5, 0.28, 0.14, 0.07)):
    """清脆铃声，用于胜负与提示"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.zeros(n)
    for i, h in enumerate(harm):
        s += h * np.sin(2 * np.pi * freq * (i + 1) * (1 + 0.0008 * i) * t)
    return s * np.exp(-t / decay) * np.clip(t / 0.004, 0, 1)


def wood_clack(freq=880.0, dur=0.18, gain=1.0):
    """木质落子：敲击瞬态 + 几个快速衰减的共振峰"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.zeros(n)
    for f, a, tau in [
        (freq, 1.0, 0.045),
        (freq * 1.94, 0.55, 0.032),
        (freq * 3.10, 0.30, 0.024),
        (freq * 4.70, 0.14, 0.016),
    ]:
        s += a * np.sin(2 * np.pi * f * t) * np.exp(-t / tau)
    noise = rng.standard_normal(n) * np.exp(-t / 0.004)
    noise = np.diff(noise, prepend=0.0)
    s = s + noise * 0.45
    s *= np.exp(-t / 0.085)
    return s * gain


def tick(freq=1500.0, dur=0.07):
    """极轻的点击 tick"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.018)
    noise = rng.standard_normal(n) * np.exp(-t / 0.0025)
    return (s * 0.8 + np.diff(noise, prepend=0.0) * 0.25) * np.exp(-t / 0.05)


def mix_at(buf, sig, start):
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    if i >= len(buf):
        return buf
    buf[i:j] += sig[: j - i]
    return buf


def reverbish(x, delays=(0.085, 0.161, 0.283), gains=(0.26, 0.16, 0.09)):
    """用几个延迟副本模拟空间感，比卷积便宜"""
    out = x.copy()
    n = len(x)
    for d, g in zip(delays, gains):
        k = int(d * SR)
        out[k:] += x[: n - k] * g
    return out


# ---------- BGM ----------

def soft_piano(freq, dur, decay=3.2, vel=0.2, attack=0.014):
    """柔和的毡化钢琴：高泛音衰减更快、起音更慢、不加锤击噪声"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.zeros(n)
    for i, h in enumerate((1.0, 0.30, 0.12, 0.05, 0.02)):
        d = decay / ((i + 1) ** 0.65)
        s += h * np.sin(2 * np.pi * freq * (i + 1) * (1 + 0.0005 * i) * t) * np.exp(-t / d)
    return s * np.clip(t / attack, 0, 1) * vel


def soft_pad(freq, dur, vel=0.14, attack=0.9, decay=3.2):
    """极轻的低频铺底，只做温度不做存在感"""
    n = int(dur * SR)
    t = t_axis(n)
    s = np.sin(2 * np.pi * freq * t) + 0.22 * np.sin(2 * np.pi * freq * 2 * t)
    s *= np.clip(t / attack, 0, 1) * np.exp(-t / decay)
    return s * vel


def onepole_lowpass(x, cutoff=4800.0):
    """一阶低通，把高频磨钝一点，音色更暖"""
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    # 逐点递推，SR=44100 时 30s 约 130 万次，可接受
    for i in range(len(x)):
        acc += alpha * (x[i] - acc)
        y[i] = acc
    return y


def build_bgm_mc(loop_sec=None, tail=4.0):
    """MC 风格环境曲（原创，柔和版）：60 BPM、I-V-vi-IV、极简钢琴 + 轻铺底

    设计取向：当背景而不是当主角。
    - 每小节只有 2 个琶音 + 1 个根音 + 1~2 个旋律音，留大量空白
    - 全部用软起音、高泛音快衰减的毡化钢琴，不加锤击噪声
    - 混响只用 3 个轻延迟，避免糊成一团
    - 2.6kHz 低通让音色退到远处；不做软限幅，避免谐波失真

    注意：只模仿这类环境音乐的气质，不复制 C418 任何一首曲子的旋律。
    """
    bpm = 60.0
    beat = 60.0 / bpm          # 1.0s
    bar = 4 * beat             # 4.0s
    bars = 8
    loop_sec = loop_sec or bars * bar   # 32s

    # I - V - vi - IV，循环两遍
    chords = [
        {'bass': 130.81, 'pad': 130.81, 'arp': [261.63, 392.00]},   # C
        {'bass': 98.00, 'pad': 98.00, 'arp': [246.94, 392.00]},     # G
        {'bass': 110.00, 'pad': 110.00, 'arp': [220.00, 329.63]},   # Am
        {'bass': 87.31, 'pad': 87.31, 'arp': [174.61, 261.63]},     # F
    ]

    # 原创旋律：每小节最多两颗音，走和弦音，句尾留白
    # (小节, 小节内拍位, 音高, 力度)
    melody = [
        (0, 0.0, 523.25, 0.26),
        (1, 1.0, 493.88, 0.22),
        (2, 0.0, 440.00, 0.26),
        (3, 2.0, 523.25, 0.20),
        (4, 0.0, 659.25, 0.28),
        (5, 1.0, 587.33, 0.22),
        (6, 0.0, 523.25, 0.26),
        (7, 1.5, 440.00, 0.20),
    ]

    total = loop_sec + tail
    buf = np.zeros(int(total * SR))

    for b in range(bars):
        t0 = b * bar
        ch = chords[b % 4]

        # 极轻的铺底
        mix_at(buf, soft_pad(ch['pad'], bar + 2.0, vel=0.11), t0)
        # 根音：只在小节头，弱
        mix_at(buf, soft_piano(ch['bass'], bar + 2.0, decay=3.6, vel=0.15), t0)
        # 琶音：一小节两颗，错开在 0.5 与 2.5 拍
        mix_at(buf, soft_piano(ch['arp'][0], 3.4, decay=3.0, vel=0.155), t0 + 0.5 * beat)
        mix_at(buf, soft_piano(ch['arp'][1], 3.4, decay=3.0, vel=0.135), t0 + 2.5 * beat)

    for bar_idx, pos, note, vel in melody:
        mix_at(buf, soft_piano(note, 4.0, decay=3.4, vel=vel), bar_idx * bar + pos * beat)

    # 克制的空间感 + 明显的暖声低通，让声音退到后面
    buf = reverbish(buf, delays=(0.13, 0.23, 0.37), gains=(0.17, 0.10, 0.05))
    buf = onepole_lowpass(buf, 2600.0)

    # 无缝循环：尾巴交叉淡化进开头
    loop = buf[: int(loop_sec * SR)].copy()
    tail_part = buf[int(loop_sec * SR):]
    k = min(len(tail_part), len(loop))
    fade = np.linspace(1.0, 0.0, k)
    loop[:k] += tail_part[:k] * fade

    # 只做归一化，不做软限幅（软限幅在这种音量下会引入可闻的谐波失真）
    return normalize(loop, peak=0.42)


def build_bgm_pentatonic(loop_sec=28.0, tail=2.5):
    total = loop_sec + tail
    buf = np.zeros(int(total * SR))

    beat = 0.5
    bars = int(loop_sec / (beat * 4))

    # 五声音阶 C D E G A（宫商角徵羽），低音走 C-G-Am-F 的感觉
    bass_seq = [130.81, 98.00, 110.00, 87.31]
    chords = [
        [261.63, 329.63, 392.00, 523.25],   # C
        [293.66, 392.00, 440.00, 587.33],   # G
        [261.63, 329.63, 440.00, 523.25],   # Am
        [293.66, 349.23, 440.00, 587.33],   # F(近似，用 E/F 混合避免半音突兀)
    ]
    high_pool = [783.99, 880.00, 1046.50]

    for bar in range(bars):
        t0 = bar * 4 * beat
        chord = chords[bar % 4]
        mix_at(buf, bass_pluck(bass_seq[bar % 4], 2.6, decay=2.4) * 0.55, t0)

        # 每小节 3~5 个音，位置固定但音高带一点变化，形成缓慢的琶音
        slots = [0.0, 1.0, 1.5, 2.5, 3.0, 3.5]
        pick = [0, 1, 3, 4, 5] if bar % 2 == 0 else [0, 2, 3, 5]
        for s in pick:
            note = chord[s % len(chord)]
            if s == 0:
                note = chord[0] * 2 if bar % 4 == 0 else chord[0]
            mix_at(buf, pluck(note, 1.6, decay=1.15) * 0.42, t0 + slots[s] * beat)

        # 隔小节来一颗高音点缀
        if bar % 2 == 1:
            mix_at(buf, pluck(high_pool[bar % 3], 1.4, decay=0.9) * 0.18, t0 + 1.75 * beat)

    buf = reverbish(buf)

    # 无缝循环：把尾巴交叉淡化进开头
    loop = buf[: int(loop_sec * SR)].copy()
    tail_part = buf[int(loop_sec * SR):]
    k = min(len(tail_part), len(loop))
    fade = np.linspace(1.0, 0.0, k)
    loop[:k] += tail_part[:k] * fade

    return normalize(soft_limit(loop), peak=0.62)


# ---------- 音效 ----------

def add(*sigs):
    """按最长长度对齐相加"""
    n = max(len(s) for s in sigs)
    out = np.zeros(n)
    for s in sigs:
        out[: len(s)] += s
    return out


def build_sfx():
    out = {}

    out['place'] = normalize(add(wood_clack(920.0, 0.2), wood_clack(1420.0, 0.09) * 0.35), peak=0.95)
    out['place_op'] = normalize(add(wood_clack(720.0, 0.2), wood_clack(1180.0, 0.09) * 0.3), peak=0.72)

    n = int(0.09 * SR)
    buf = np.zeros(n)
    mix_at(buf, tick(1650.0), 0.0)
    out['tap'] = normalize(buf, peak=0.42)

    # 胜利：C5-E5-G5 上行三音
    b = np.zeros(int(1.9 * SR))
    for i, f in enumerate([523.25, 659.25, 783.99]):
        mix_at(b, bell(f, 1.5, decay=0.62) * (0.85 - 0.08 * i), i * 0.135)
    out['win'] = normalize(b, peak=0.85)

    # 失败：A3-F3 下行两音，音色更闷
    b = np.zeros(int(2.1 * SR))
    for i, f in enumerate([220.00, 174.61]):
        s = bell(f, 1.8, decay=0.85, harm=(1.0, 0.28, 0.10, 0.05))
        mix_at(b, s * 0.9, i * 0.19)
    out['lose'] = normalize(b, peak=0.72)

    # 和棋：单音
    b = np.zeros(int(1.6 * SR))
    mix_at(b, bell(392.00, 1.4, decay=0.7) * 0.85, 0.0)
    out['draw'] = normalize(b, peak=0.7)

    # 收到消息：叮咚两声
    b = np.zeros(int(0.75 * SR))
    mix_at(b, bell(1046.50, 0.5, decay=0.22, harm=(1.0, 0.35, 0.12)) * 0.75, 0.0)
    mix_at(b, bell(1318.51, 0.45, decay=0.2, harm=(1.0, 0.35, 0.12)) * 0.6, 0.085)
    out['msg'] = normalize(b, peak=0.6)

    for k in out:
        out[k] = soft_limit(out[k])
    return out


# ---------- 编码输出 ----------

def encode(x, name, bitrate=112):
    pcm = np.clip(x, -1.0, 1.0)
    try:
        import lameenc
        enc = lameenc.Encoder()
        enc.set_bit_rate(bitrate)
        enc.set_in_sample_rate(SR)
        enc.set_channels(1)
        enc.set_quality(2)
        data = enc.encode((pcm * 32767).astype('<i2').tobytes())
        data += enc.flush()
        path = os.path.join(OUT, name + '.mp3')
        with open(path, 'wb') as f:
            f.write(data)
        return path
    except Exception as e:
        import wave
        path = os.path.join(OUT, name + '.wav')
        data = (pcm * 32767).astype('<i2').tobytes()
        with wave.open(path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(data)
        print('[fallback wav]', e)
        return path


if __name__ == '__main__':
    import sys
    style = 'mc'
    only = 'all'
    for arg in sys.argv[1:]:
        if arg.startswith('--style='):
            style = arg.split('=', 1)[1]
        if arg.startswith('--only='):
            only = arg.split('=', 1)[1]

    if only in ('all', 'bgm'):
        bgm = build_bgm_mc() if style == 'mc' else build_bgm_pentatonic()
        # 背景音乐用 96kbps：低码率 mp3 对钢琴长混响的编码噪声很明显
        p = encode(bgm, 'bgm', bitrate=96)
        print('bgm(%s) ->' % style, os.path.getsize(p), 'bytes  %.1fs' % (len(bgm) / SR))
        print('  peak %.3f  rms %.3f' % (np.max(np.abs(bgm)), np.sqrt(np.mean(bgm ** 2))))

    if only in ('all', 'sfx'):
        for name, sig in build_sfx().items():
            p = encode(sig, name, bitrate=96)
            print(name, '->', os.path.getsize(p), 'bytes  %.2fs' % (len(sig) / SR))
