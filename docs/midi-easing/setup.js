const smoothstep = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t ** 2;
const easeOut = (t, power = 2) => 1 - (1 - t) ** power;
const elastic = (t) => 1 - (1 - t) ** 3 * Math.cos(3 * Math.PI * t);
