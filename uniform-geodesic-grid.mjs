#!/usr/bin/env node
/* eslint-disable newline-per-chained-call */
const d3 = {
  ...(await import("d3-geo")),
  ...(await import("d3-geo-projection")),
  ...(await import("d3-geo-polygon")),
  ...(await import("d3-geo-voronoi")),
};
import * as cmd from "commander";

// Parse the arguments
const args = cmd.program
  .name('uniform-geodesic-grid')
  .description('Generate a homogenously spaced hexagonal geodesic grid.')
  .version('0.1.0')
  .addOption(new cmd
    .Option("--cell-size <km>", "target median cell diameter in km")
    .argParser((value) => {
       value = parseFloat(value)
       if (isNaN(value)) throw new cmd.InvalidArgumentError();
       if (value > 7400 || value < 40) throw new cmd.InvalidArgumentError('Cell size must be between 40 and 7400 km');
       return value
    })
    .conflicts("k")
  )
  .addOption(new cmd
    .Option("--k <subdivisions>", "number of triangle edge subdivisions for grid generation")
    .default(10)
    .argParser((value) => {
       value = parseInt(value)
       if (isNaN(value) || value <= 0 ) throw new cmd.InvalidArgumentError();
       if (value > 250) throw new cmd.InvalidArgumentError('Number of subdivisions should not exceed 250');
       return value
    })
    .conflicts("cellSize")
  )
  .addOption(new cmd
    .Option("--pretty", "pretty-format the JSON output")
    .default(false)
  )
  .parse().opts()

// determine K, the number of triangle side subdivisions
//
// there are 10*K^2 + 2 cells, so we can estimate the expected
// cell size using the Earth surface area
const earth_radius = 6371.01;
const K = (args.cellSize)
  ? Math.round(Math.sqrt(1.6*(earth_radius/args.cellSize)**2 - 0.2))
  : args.k;

// utility functions
function* range(start, end) {
  if (start >= end) return
  for (let i = start; i < end; i++) yield i;
}

function* rasterizeTriangle(tri, k, includeEdges = false) {
  const step = 1.0 / k;
  const offset = includeEdges ? 0 : 1
  for (let u = k - offset; u >= offset; u -= 1) {
    for (let v = offset; v <= k - u - offset; v += 1) {
      const barycentrics = [u * step, v * step, (k - u - v) * step];
      // calculate the point coordinates from barycentrics
      yield tri[0].map((_, ci) => {
        return barycentrics.reduce((sum, w, vi) => sum + tri[vi][ci] * w, 0);
      });
    }
  }
}
// Produces an equally spaced points within the triangle
// using k subdivisions of the barycentric coordinates
// function* rasterizeTriangleInside(tri, k) {
//   const step = 1.0 / k;
//   for (let u = k - 1; u > 0; u -= 1) {
//     for (let v = 1; v < k - u; v += 1) {
//       const barycentrics = [u * step, v * step, (k - u - v) * step];
//       // calculate the point coordinates from barycentrics
//       yield tri[0].map((_, ci) => {
//         return barycentrics.reduce((sum, w, vi) => sum + tri[vi][ci] * w, 0);
//       });
//     }
//   }
// }

// a single icosahedron face as a geodesic triangle
const theta = (Math.atan(0.5) / Math.PI) * 180;
let triangle = [
  [0, theta],
  [36, -theta],
  [-36, -theta],
];
triangle.centroid = d3.geoCentroid({
  type: "Polygon",
  coordinates: [[...triangle, triangle[0]]],
});

// Set up the Gray-Fuller projection, which we use to project
// between the geodesic triangle and the planar triangle
const proj = d3
  .geoProjection(d3.geoGrayFullerRaw())
  .rotate([-triangle.centroid[0], -triangle.centroid[1]])
  .center([0, triangle[0][1] - triangle.centroid[1]])
  .scale(1)
  .translate([0, 0]);

// generate equally spaced points on the geodesic sphere
// note: only consider the point inside the triangle,
//       we will add edges and vertices later since they are
//       shared between multiple faces of the icosahedron
const face_points = [...rasterizeTriangle(triangle.map(proj), K, false)]
  .map((p) => proj.invert(p))
  .map((p) => [p, d3.geoRotation([0, 90 - theta, 180])(p)])
  .flatMap( ([[x0, y0], [x1, y1]]) => [
    // 10 triangles forming the middle section of the sphere
    ...range(0, 10).map((i) => [x0 + i * 36, (i % 2 ? -1 : 1) * y0]),
    // 5 triangles forming the north cap
    ...range(0, 5).map((i) => [x1  + i*72, y1]),
    // 5 triangles forming the south cap
    ...range(0, 5).map((i) => [36 - x1 + i * 72, -y1]),
  ])

// generate the vertices and edges
const vertices = [
    [0, 90],
    [0, -90],
    ...range(0, 10).map((i) => [((i * 36 + 180) % 360) - 180, i & 1 ? -theta : theta])
  ]

const edges = vertices.flatMap( (v0, i) => vertices.slice(i+1).flatMap( (v1) => {
  // we know th distance between neighbouring vertices
  if (Math.abs(d3.geoDistance(v0, v1) - 1.1) >= 0.01) return [];

  // interpolate along the edge
  const interpolator = d3.geoInterpolate(v0, v1);
  return [...range(1, K).map( (i) => interpolator(i/K))]
}))

// combine the points and rotate them to place the icosahedron vertices in the ocean
const points = [...vertices, ...edges, ...face_points]
  .map(d3.geoRotation([36, 0, 0]))
  .map(d3.geoRotation(d3.geoAirocean().rotate()).invert)

// build the voronoi diagram of grid cells
const voronoi = d3.geoVoronoi(points);
const delaunay = voronoi.delaunay;

function as_lonlat([lon, lat]) {
  return { lon: lon, lat: lat };
}

function make_cell_polygon(delaunay_polygon) {
  let ring = [...delaunay_polygon.reverse().map( (j) => delaunay.centers[j])]
  ring.push(ring[0])

  return ring
}

// Produce GeoJSON representation of cells
const cell_features = range(0, voronoi.points.length).map((i) => ({
  type: "Feature",
  properties: {
    // grid cell id
    gid: i,
    // longitude,lattitude coordinates of the cell center
    ...as_lonlat(voronoi.points[i]),
    // cell neighbours (0-indexing)
    neighbors: delaunay.neighbors[i],
    // cell location on the icosahedron
    icosahedron_placement: (i < vertices.length + edges.length) ? ((i < vertices.length) ? "vertex" : "edge") : "face"
  },
  geometry: {
    type: "Polygon",
    coordinates: [make_cell_polygon(delaunay.polygons[i])]
  }
}));

// output the cell geometry as GeoJSON
console.log(JSON.stringify({
  type: "FeatureCollection",
  features: [...cell_features]
}
, null, args.pretty ? 2 : 0))
